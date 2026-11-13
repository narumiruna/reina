import { createHmac, generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import type { Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pino } from "pino"
import { Probot, ProbotOctokit } from "probot"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { artifactHash } from "../src/agent/validate.js"
import { httpServer, register, sanitizeWebhook, webhookWork } from "../src/app.js"
import { Publisher, proposalBody } from "../src/github/publisher.js"
import { branchFor, GitHub, type GitHubClient } from "../src/github/scanner.js"
import { publishReview } from "../src/github/triage.js"
import { Orchestrator } from "../src/jobs/orchestrator.js"
import { Store } from "../src/jobs/store.js"
import type { Assessment } from "../src/triage/assessment.js"
import { REVIEW_LABELS, type Review } from "../src/triage/review.js"
import type {
  Actor,
  AgentRuntime,
  Config,
  Issue,
  Job,
  LabelEvent,
  Proposal,
  Snapshot,
  TriageDecision,
} from "../src/types.js"

// An ephemeral key and test token exercise Probot initialization without any
// GitHub installation or live API. Unexpected Octokit requests always fail.
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2_048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
const token = "ghs_test_fixture_not_a_real_token"
const webhookSecret = "credential-free-webhook-fixture-secret"
const botId = 99
const maintainer: Actor = { id: 50, login: "maintainer", type: "User" }
const outsider: Actor = { id: 51, login: "outsider", type: "User" }
const rawIssueBody = "RAW_ISSUE_BODY_MUST_NOT_REACH_PROBOT_OR_LOGS"
const rawCommentBody = "RAW_COMMENT_BODY_MUST_NOT_REACH_PROBOT_OR_LOGS"
const image = `ghcr.io/example/reina@sha256:${"d".repeat(64)}`
let directory: string
let now: number
const active: AppFixture[] = []

type Envelope = ReturnType<typeof payload>
interface AppFixture {
  config: Config
  app: Probot
  github: MockGitHub
  publisher: MockPublisher
  store: Store
  runtime: ReturnType<typeof controlledRuntime>
  orchestrator: Orchestrator
  server: Server
  url: string
  logs: string[]
  log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }
  network: ReturnType<typeof vi.fn<typeof fetch>>
  approval(actor?: Actor): Envelope
  post(payload: unknown, delivery: string, name?: string): Promise<Response>
  postRaw(raw: string, delivery: string, name?: string, signature?: string): Promise<Response>
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "reina-app-"))
  now = Date.parse("2026-11-03T12:00:00Z")
  vi.spyOn(Date, "now").mockImplementation(() => now)
})

afterEach(async () => {
  for (const value of active.splice(0)) {
    await value.orchestrator.stop()
    value.server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      value.server.close((error) => (error ? reject(error) : resolve()))
    })
    value.store.close()
    expect(value.network).not.toHaveBeenCalled()
  }
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

function configuration(): Config {
  return {
    repository: { owner: "example", name: "project", id: 456, installationId: 789 },
    stateDir: join(directory, "state"),
    image,
    model: "openai/fixture-model",
    modelUrl: "https://model.invalid/v1",
    modelKey: "fixture-model-key-not-a-credential",
    allowedPaths: ["README.md", "docs/**", "src/**", "tests/**"],
    forbiddenPaths: ["src/identity/**", "src/security/**", "src/release/**"],
    commands: [["node", "--test", "tests/readme.test.mjs"]],
    scanIntervalMs: 900_000,
    maxIssuesPerScan: 10,
    maxConcurrentJobs: 1,
    agentTimeoutMs: 600_000,
    maxChangedFiles: 10,
    maxPatchBytes: 65_536,
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    installation: { id: 789 },
    repository: {
      id: 456,
      name: "project",
      owner: { login: "example" },
      default_branch: "main",
    },
    sender: { ...maintainer },
    issue: {
      id: 1_012,
      number: 12,
      title: "RAW_TITLE_MUST_NOT_REACH_PROBOT",
      body: rawIssueBody,
    },
    ...overrides,
  }
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("fixture_value_missing")
  return value
}

function triageDecision(): TriageDecision {
  return {
    eligible: true,
    category: "documentation",
    reason: "The usage example has an incorrect command name.",
    proposedFix: "Correct the command name in the usage example.",
    affectedFiles: ["README.md"],
    verificationPlan: ["Inspect the corrected example."],
    requiresHumanDecision: false,
    risks: [],
  }
}

function triageAssessment(): Assessment {
  return {
    kind: "documentation",
    summary: "The usage example has an incorrect command name.",
    missingInfo: [],
    fix: triageDecision(),
  }
}

function controlledRuntime(value: Config) {
  return {
    preflight: vi.fn<AgentRuntime["preflight"]>(async () => {}),
    cleanup: vi.fn<AgentRuntime["cleanup"]>(async () => {}),
    triage: vi.fn<AgentRuntime["triage"]>(async () => JSON.stringify(triageAssessment())),
    code: vi.fn<AgentRuntime["code"]>(async (snapshot, _prompt, signal) => {
      signal.throwIfAborted()
      return {
        finalText: "The agent reports success. Trusted checks must still run.",
        files: {
          ...snapshot.files,
          "README.md": { mode: "100644", content: Buffer.from("npm run ci\n") },
        },
      }
    }),
    verify: vi.fn<AgentRuntime["verify"]>(async (_snapshot, commands, signal) => {
      signal.throwIfAborted()
      return commands.map((argv) => ({
        argv: [...argv],
        exitCode: 0,
        durationMs: 23,
        image: value.image,
      }))
    }),
  } satisfies AgentRuntime
}

class MockGitHub extends GitHub {
  currentIssue: Issue
  baseline: Snapshot = {
    branch: "main",
    sha: "a".repeat(40),
    files: {
      "README.md": { mode: "100644", content: Buffer.from("npn run ci\n") },
      "tests/readme.test.mjs": { mode: "100644", content: Buffer.from("// trusted check\n") },
    },
  }
  events: LabelEvent[] = []
  remoteComments: {
    id: number
    body: string
    created_at: string
    user: { id: number; type: string; login: string }
  }[] = []
  permissions = new Map([
    [maintainer.login, "write"],
    [outsider.login, "read"],
  ])
  refs = new Map<string, string>()

  constructor(value: Config) {
    super({} as GitHubClient, value.repository, botId)
    this.currentIssue = {
      ref: { ...value.repository, number: 12, issueId: 1_012 },
      title: "Correct the usage example",
      body: "Replace npn with npm in the usage example.",
      comments: [],
      labels: [],
      state: "open",
      pullRequest: false,
    }
    Object.assign(this.client, this.api)
  }

  private scoped(params: {
    owner: string
    repo: string
    issue_number?: number
    request?: { retries: number }
  }) {
    expect(params.owner).toBe(this.repository.owner)
    expect(params.repo).toBe(this.repository.name)
    expect(params.request?.retries).toBe(0)
    if (params.issue_number !== undefined)
      expect(params.issue_number).toBe(this.currentIssue.ref.number)
  }

  private reviewComment(id: number) {
    const comment = this.remoteComments.find((comment) => comment.id === id)
    if (!comment) throw Object.assign(new Error("fixture_comment_missing"), { status: 404 })
    expect(comment.body.startsWith("<!-- reina:triage:")).toBe(true)
    return comment
  }

  api = {
    auth: vi.fn(async () => ({
      tokenType: "installation",
      installationId: this.repository.installationId,
    })),
    rest: {
      repos: {
        get: vi.fn(async (params: { owner: string; repo: string }) => {
          this.scoped(params)
          return { data: { ...this.repository, owner: { login: this.repository.owner } } }
        }),
      },
      issues: {
        get: vi.fn(async (params: { owner: string; repo: string; issue_number: number }) => {
          this.scoped(params)
          return {
            data: {
              id: this.currentIssue.ref.issueId,
              number: this.currentIssue.ref.number,
              state: this.currentIssue.state,
              labels: [...this.currentIssue.labels],
              pull_request: this.currentIssue.pullRequest ? {} : undefined,
            },
          }
        }),
        getComment: vi.fn(async (params: { owner: string; repo: string; comment_id: number }) => {
          this.scoped(params)
          return { data: structuredClone(this.reviewComment(params.comment_id)) }
        }),
        createComment: vi.fn(
          async (params: { owner: string; repo: string; issue_number: number; body: string }) => {
            this.scoped(params)
            expect(params.body.startsWith("<!-- reina:triage:456:1012 -->\n")).toBe(true)
            expect(this.remoteComments.some((comment) => comment.id === 400)).toBe(false)
            const comment = {
              id: 400,
              body: params.body,
              user: { id: botId, type: "Bot", login: "reina[bot]" },
              created_at: new Date(Date.now()).toISOString(),
            }
            this.remoteComments.push(comment)
            this.currentIssue.comments.push({ id: 400, authorId: botId, body: params.body })
            return { data: structuredClone(comment) }
          },
        ),
        updateComment: vi.fn(
          async (params: { owner: string; repo: string; comment_id: number; body: string }) => {
            this.scoped(params)
            const comment = this.reviewComment(params.comment_id)
            comment.body = params.body
            required(this.currentIssue.comments.find((item) => item.id === comment.id)).body =
              params.body
            return { data: structuredClone(comment) }
          },
        ),
        getLabel: vi.fn(async (params: { owner: string; repo: string; name: string }) => {
          this.scoped(params)
          expect(REVIEW_LABELS).toContain(params.name)
          return { data: { name: params.name } }
        }),
        addLabels: vi.fn(
          async (params: {
            owner: string
            repo: string
            issue_number: number
            labels: string[]
          }) => {
            this.scoped(params)
            for (const name of params.labels) expect(REVIEW_LABELS).toContain(name)
            this.currentIssue.labels = [...new Set([...this.currentIssue.labels, ...params.labels])]
            return { data: [...this.currentIssue.labels] }
          },
        ),
        removeLabel: vi.fn(
          async (params: { owner: string; repo: string; issue_number: number; name: string }) => {
            this.scoped(params)
            expect(REVIEW_LABELS).toContain(params.name)
            this.currentIssue.labels = this.currentIssue.labels.filter(
              (name) => name !== params.name,
            )
            return { data: [...this.currentIssue.labels] }
          },
        ),
      },
    },
  }

  override issue = vi.fn(
    async (_number: number): Promise<Issue> => ({
      ...this.currentIssue,
      ref: { ...this.currentIssue.ref },
      labels: [...this.currentIssue.labels],
      comments: this.currentIssue.comments.map((comment) => ({ ...comment })),
    }),
  )
  override head = vi.fn(async () => ({ branch: this.baseline.branch, sha: this.baseline.sha }))
  override snapshotAt = vi.fn(
    async (branch: string, sha: string): Promise<Snapshot> => ({
      branch,
      sha,
      files: Object.fromEntries(
        Object.entries(this.baseline.files).map(([path, file]) => [
          path,
          { mode: file.mode, content: Buffer.from(file.content) },
        ]),
      ),
    }),
  )
  override comments = vi.fn(
    async (_number: number) =>
      this.remoteComments.map((comment) => ({ ...comment, user: { ...comment.user } })) as Awaited<
        ReturnType<GitHub["comments"]>
      >,
  )
  override history = vi.fn(async (_number: number) =>
    this.events.map((event) => ({ ...event, actor: { ...event.actor } })),
  )
  override permission = vi.fn(async (login: string) => this.permissions.get(login) ?? "none")
  override ref = vi.fn(async (branch: string) => this.refs.get(branch))
  override conflicts = vi.fn(async (number: number) => this.refs.has(branchFor(number)))
  override discover = vi.fn(async (_limit: number, _page = 1) => ({
    numbers: [] as number[],
    nextPage: 1,
  }))
}

class MockPublisher extends Publisher {
  comments = new Map<string, { commentId: number; publishedAt: number }>()
  drafts = new Map<string, { number: number; url: string }>()

  constructor(
    private reader: MockGitHub,
    private store: Store,
  ) {
    super({} as GitHubClient, reader.repository, reader.botId)
  }

  createComment = vi.fn(async (proposal: Proposal) => {
    const comment = { commentId: 500 + this.comments.size, publishedAt: Date.now() }
    this.comments.set(proposal.revision, comment)
    this.reader.remoteComments.push({
      id: comment.commentId,
      body: proposalBody(proposal),
      user: { id: botId, type: "Bot", login: "reina[bot]" },
      created_at: new Date(comment.publishedAt).toISOString(),
    })
    this.reader.currentIssue.comments.push({
      id: comment.commentId,
      authorId: botId,
      body: proposalBody(proposal),
    })
    return comment
  })

  override propose = vi.fn(async (proposal: Proposal, save?: (value: Proposal) => void) => {
    const existing = this.comments.get(proposal.revision)
    if (existing) return existing
    proposal.commentIntent = true
    save?.(proposal)
    expect(this.store.proposal(proposal.ref)?.commentIntent).toBe(true)
    return this.createComment(proposal)
  })

  override review = vi.fn((review: Review, save: (value: Review) => void, signal?: AbortSignal) =>
    publishReview(this.reader, review, save, signal),
  )

  override labels = vi.fn(async (_number: number, add: string[], remove: string[]) => {
    if (remove.includes("bot:skip")) throw new Error("maintainer_label_must_not_be_removed")
    this.reader.currentIssue.labels = [
      ...new Set([
        ...this.reader.currentIssue.labels.filter((label) => !remove.includes(label)),
        ...add,
      ]),
    ]
  })

  createDraft = vi.fn(async (input: { jobId: string; head: string; base: string; draft: true }) => {
    const draft = { number: 40, url: "https://github.com/example/project/pull/40" }
    this.drafts.set(input.jobId, draft)
    return draft
  })

  override publish = vi.fn(async (job: Job, proposal: Proposal, save: (value: Job) => void) => {
    expect(this.store.job(job.id)?.state).toBe("publishing")
    const artifact = required(job.artifact)
    expect(artifact.hash).toBe(artifactHash(artifact))
    const branch = branchFor(job.ref.number)
    let current: Job = { ...job, publication: { branch }, updatedAt: Date.now() }
    save(current)
    current = { ...current, publication: { branch, commitSha: "b".repeat(40) } }
    save(current)
    this.reader.refs.set(branch, "b".repeat(40))
    current = { ...current, publication: { branch, commitSha: "b".repeat(40), prIntent: true } }
    save(current)
    const draft =
      this.drafts.get(job.id) ??
      (await this.createDraft({
        jobId: job.id,
        draft: true,
        head: branch,
        base: proposal.baseBranch,
      }))
    current = {
      ...current,
      state: "pr_ready",
      updatedAt: Date.now(),
      publication: {
        branch,
        commitSha: "b".repeat(40),
        prIntent: true,
        prNumber: draft.number,
        prUrl: draft.url,
      },
    }
    save(current)
    await this.labels(
      job.ref.number,
      ["bot:pr_ready"],
      ["bot:working", "bot:failed", "fix_available", "bot:approved"],
    )
    return current
  })
}

async function fixture(): Promise<AppFixture> {
  const value = configuration()
  const logs: string[] = []
  const network = vi.fn<typeof fetch>(async () => {
    throw new Error("live_api_forbidden")
  })
  const app = new Probot({
    appId: 123,
    privateKey,
    githubToken: token,
    secret: webhookSecret,
    Octokit: ProbotOctokit.defaults({
      auth: { token },
      throttle: { enabled: false },
      retry: { enabled: false },
    }),
    request: { fetch: network },
    log: pino(
      { level: "trace" },
      {
        write: (chunk: string) => {
          logs.push(chunk)
        },
      },
    ),
  })
  await app.ready()
  const store = new Store(value.stateDir)
  const github = new MockGitHub(value)
  const publisher = new MockPublisher(github, store)
  const runtime = controlledRuntime(value)
  const orchestrator = new Orchestrator(
    value,
    store,
    runtime,
    async () => ({ github, publisher }),
    botId,
    {
      info: vi.fn(),
      error: vi.fn(),
    },
  )
  register(app, value, orchestrator, botId)
  const log = { info: vi.fn(), error: vi.fn() }
  const server = httpServer(app, log)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing_http_address")
  const url = `http://127.0.0.1:${address.port}`
  const result: AppFixture = {
    config: value,
    app,
    github,
    publisher,
    store,
    runtime,
    orchestrator,
    server,
    url,
    logs,
    log,
    network,
    approval(actor = maintainer) {
      if (github.currentIssue.labels.includes("bot:approved")) {
        now += 1_000
        github.events.push({
          id: String(1_000 + github.events.length),
          event: "unlabeled",
          label: "bot:approved",
          actor,
          createdAt: now,
        })
        github.currentIssue.labels = github.currentIssue.labels.filter(
          (label) => label !== "bot:approved",
        )
      }
      now += 1_000
      github.currentIssue.labels.push("bot:approved")
      github.events.push({
        id: String(1_000 + github.events.length),
        event: "labeled",
        label: "bot:approved",
        actor,
        createdAt: now,
      })
      return payload({ action: "labeled", label: { name: "bot:approved" }, sender: actor })
    },
    post(body, delivery, name = "issues") {
      return result.postRaw(JSON.stringify(body), delivery, name)
    },
    postRaw(raw, delivery, name = "issues", signature = sign(raw)) {
      return fetch(`${url}/api/github/webhooks`, {
        method: "POST",
        body: raw,
        signal: AbortSignal.timeout(5_000),
        headers: {
          "content-type": "application/json",
          "x-github-delivery": delivery,
          "x-github-event": name,
          "x-hub-signature-256": signature,
        },
      })
    },
  }
  active.push(result)
  return result
}

function sign(raw: string) {
  return `sha256=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`
}

async function receive(value: AppFixture, name: string, data: unknown, id = "probot-receive") {
  await value.app.receive({ id, name, payload: sanitizeWebhook(data) } as Parameters<
    Probot["receive"]
  >[0])
}

function expectNoPrivateLogs(value: AppFixture) {
  const logs = `${value.logs.join("\n")}\n${JSON.stringify(value.log.error.mock.calls)}`
  for (const text of [rawIssueBody, rawCommentBody, privateKey, token, value.config.modelKey]) {
    expect(logs).not.toContain(text)
  }
}

describe("webhook routing and bounded event data", () => {
  test("delayed App-owned label projections cannot revoke a later proposal", () => {
    const event = payload({
      sender: { id: botId, login: "reina[bot]", type: "Bot" },
      action: "unlabeled",
      label: { name: "bot:approved" },
    })
    expect(webhookWork("issues", event, configuration(), botId)).toBeUndefined()
    expect(
      webhookWork(
        "issues",
        { ...event, action: "labeled", label: { name: "bot:skip" } },
        configuration(),
        botId,
      ),
    ).toMatchObject({ cancel: true })
  })

  test("signed repository casing uses the immutable allowlist identity", () => {
    const event = payload()
    event.repository.name = event.repository.name.toUpperCase()
    event.repository.owner.login = event.repository.owner.login.toUpperCase()
    expect(webhookWork("issues", event, configuration(), botId)).toMatchObject({ kind: "issue" })
  })

  test("removes raw context and credentials before Probot can log an event", () => {
    expect(
      sanitizeWebhook(
        payload({
          token: "private-root-token",
          comment: { body: rawCommentBody, user: { id: 50, token: "private-user-token" } },
          installation: { id: 789, access_tokens_url: "https://private.invalid" },
          repository: {
            id: 456,
            name: "project",
            owner: { login: "example", email: "private@example.invalid" },
            default_branch: "main",
            description: "private repository description",
          },
        }),
      ),
    ).toEqual({
      action: "opened",
      installation: { id: 789 },
      repository: { id: 456, name: "project", owner: { login: "example" }, default_branch: "main" },
      sender: maintainer,
      issue: { id: 1_012, number: 12 },
      comment: { user: { id: 50 } },
    })
  })

  test.each([
    ["opened", undefined, false, false],
    ["edited", undefined, true, false],
    ["reopened", undefined, true, false],
    ["closed", undefined, false, true],
    ["deleted", undefined, false, true],
    ["labeled", "bot:approved", false, false],
    ["unlabeled", "bot:approved", false, true],
    ["labeled", "bot:skip", false, true],
    ["labeled", "unrelated", false, false],
  ] as const)("maps issues.%s (%s) to durable control data", (action, label, material, cancel) => {
    const data = payload({ action, ...(label ? { label: { name: label } } : {}) })
    const work = webhookWork("issues", data, configuration(), botId)
    expect(work).toMatchObject({
      kind: "issue",
      action,
      material,
      cancel,
      actor: maintainer,
      ref: { ...configuration().repository, number: 12, issueId: 1_012 },
    })
    expect(JSON.stringify(work)).not.toContain(rawIssueBody)
    if (label) expect(work).toHaveProperty("label", label)
  })

  test.each(["created", "edited", "deleted"])(
    "treats human comment %s as material but ignores Reina comments",
    (action) => {
      const data = payload({
        action,
        comment: { user: { id: maintainer.id }, body: rawCommentBody },
      })
      expect(webhookWork("issue_comment", data, configuration(), botId)).toMatchObject({
        kind: "issue",
        material: true,
        cancel: action === "deleted",
      })
      expect(
        webhookWork(
          "issue_comment",
          { ...data, comment: { user: { id: botId } } },
          configuration(),
          botId,
        ),
      ).toBeUndefined()
    },
  )

  test.each([
    { installation: { id: 790 } },
    { repository: { id: 999, name: "project", owner: { login: "example" } } },
    { repository: { id: 456, name: "other", owner: { login: "example" } } },
    { repository: { id: 456, name: "project", owner: { login: "other" } } },
    { issue: { id: 1_012, number: 12, pull_request: {} } },
    { action: "assigned" },
  ])("ignores foreign, PR, or unsupported issue events: %j", (overrides) => {
    expect(webhookWork("issues", payload(overrides), configuration(), botId)).toBeUndefined()
  })

  test.each([
    ["push", { ref: "refs/heads/main" }, { kind: "invalidate", branch: "main", disable: false }],
    ["repository", { action: "edited" }, { kind: "invalidate", disable: false }],
    ["repository", { action: "archived" }, { kind: "invalidate", disable: true }],
    ["repository", { action: "transferred" }, { kind: "invalidate", disable: true }],
    ["repository", { action: "deleted" }, { kind: "invalidate", disable: true }],
    ["installation", { action: "deleted" }, { kind: "invalidate", disable: true }],
    ["installation", { action: "suspend" }, { kind: "invalidate", disable: true }],
    [
      "installation_repositories",
      { repositories_removed: [{ id: 456 }] },
      { kind: "invalidate", disable: true },
    ],
    ["pull_request", { action: "closed" }, { kind: "scan", reason: "pull_request_changed" }],
  ])("maps %s repository authority changes", (name, overrides, expected) => {
    expect(webhookWork(name, payload(overrides), configuration(), botId)).toEqual(expected)
  })

  test("ignores tag pushes, unrelated access removal, unknown names, and malformed envelopes", () => {
    const value = configuration()
    expect(webhookWork("push", payload({ ref: "refs/tags/v1" }), value, botId)).toBeUndefined()
    expect(
      webhookWork(
        "installation_repositories",
        payload({ repositories_removed: [{ id: 999 }] }),
        value,
        botId,
      ),
    ).toBeUndefined()
    expect(webhookWork("ping", payload(), value, botId)).toBeUndefined()
    expect(webhookWork("issues", { issue: { id: -1 } }, value, botId)).toBeUndefined()
    expect(() => sanitizeWebhook({ action: "x".repeat(65) })).toThrow()
  })

  test("real Probot.receive dispatches sanitized event IDs and cancellation data", async () => {
    const value = await fixture()
    const intake = vi.spyOn(value.orchestrator, "accept").mockImplementation(() => {})
    await receive(
      value,
      "issues",
      payload({ action: "unlabeled", label: { name: "bot:approved" } }),
      "received-label-removal",
    )
    expect(intake).toHaveBeenLastCalledWith(
      "received-label-removal",
      expect.objectContaining({
        kind: "issue",
        action: "unlabeled",
        label: "bot:approved",
        cancel: true,
        material: false,
      }),
    )
    await receive(
      value,
      "issue_comment",
      payload({ action: "edited", comment: { user: { id: 50 }, body: rawCommentBody } }),
      "received-comment-edit",
    )
    expect(intake).toHaveBeenLastCalledWith(
      "received-comment-edit",
      expect.objectContaining({ material: true }),
    )
    await receive(
      value,
      "issues",
      payload({ issue: { id: 1_012, number: 12, pull_request: {} } }),
      "excluded-pr",
    )
    expect(intake).toHaveBeenCalledTimes(2)
    expectNoPrivateLogs(value)
  })
})

describe("signed HTTP ingress and the complete credential-free workflow", () => {
  test("acknowledges durable intake before triage and produces one independently verified draft", async () => {
    const value = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    value.runtime.triage.mockImplementation(async (_snapshot, _prompt, signal) => {
      entered.resolve()
      const aborted = Promise.withResolvers<never>()
      const cancel = () => aborted.reject(signal.reason)
      signal.addEventListener("abort", cancel, { once: true })
      try {
        await Promise.race([release.promise, aborted.promise])
        return JSON.stringify(triageAssessment())
      } finally {
        signal.removeEventListener("abort", cancel)
      }
    })
    const dispatched: unknown[] = []
    value.app.onAny((context) => {
      dispatched.push(context.payload)
    })
    const response = await value.post(payload(), "opened-1")
    expect(response.status).toBe(202)
    await entered.promise
    expect(value.store.deliveries()).toEqual([
      {
        id: "opened-1",
        payload: expect.objectContaining({ kind: "issue", action: "opened" }),
      },
    ])
    expect(value.store.proposal(value.github.currentIssue.ref)).toBeUndefined()
    expect(value.runtime.code).not.toHaveBeenCalled()
    expect((await value.post(payload(), "opened-1")).status).toBe(202)
    expect(value.runtime.triage).toHaveBeenCalledTimes(1)
    release.resolve()
    await value.orchestrator.drain()
    const proposal = required(value.store.proposal(value.github.currentIssue.ref))
    expect(proposal).toMatchObject({ commentIntent: true, commentId: 500, publishedAt: now })
    expect(proposal.decision).toEqual(triageDecision())
    const review = required(value.store.review(value.github.currentIssue.ref))
    expect(review).toMatchObject({
      state: "complete",
      outcome: "fix_candidate",
      assessment: triageAssessment(),
      attempts: 1,
      commentIntent: true,
      commentId: 400,
      assessedAt: now,
      publishedRevision: review.revision,
    })
    expect(value.github.remoteComments).toHaveLength(2)
    const summary = structuredClone(
      required(value.github.remoteComments.find((item) => item.id === 400)),
    )
    expect(summary.body).toContain("<!-- reina:triage:456:1012 -->\n")
    expect(summary.body).toContain("Next action: fix_candidate")
    expect(summary.body).toContain("Triage did not modify code or verify a fix.")
    const proposalComment = structuredClone(
      required(value.github.remoteComments.find((item) => item.id === proposal.commentId)),
    )
    expect(proposalComment.body).toBe(proposalBody(proposal))
    expect(proposalComment.body).toContain(
      `<!-- reina:proposal:456:1012:${proposal.revision} -->\n`,
    )
    expect(value.github.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(value.publisher.createComment).toHaveBeenCalledTimes(1)
    expect(value.github.currentIssue.labels).toEqual(["bot:triaged", "fix_available"])
    expect(value.runtime.triage.mock.calls[0][1]).toContain(value.github.currentIssue.body)
    expect(value.runtime.triage.mock.calls[0][1]).not.toContain(rawIssueBody)

    expect((await value.post(value.approval(outsider), "outsider-approval")).status).toBe(202)
    await value.orchestrator.drain()
    expect(value.store.jobs()).toEqual([])
    expect(value.runtime.code).not.toHaveBeenCalled()
    expect(value.publisher.createDraft).not.toHaveBeenCalled()

    const approval = value.approval()
    expect((await value.post(approval, "maintainer-approval")).status).toBe(202)
    await value.orchestrator.drain()
    const jobs = value.store.jobs()
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({
      state: "pr_ready",
      approval: { actor: maintainer, permission: "write", createdAt: now },
      publication: { branch: branchFor(12), prIntent: true, prNumber: 40 },
    })
    expect(jobs[0].approval.createdAt).toBeGreaterThan(required(proposal.publishedAt))
    expect(jobs[0].artifact?.verification).toEqual([
      { argv: value.config.commands[0], exitCode: 0, durationMs: 23, image },
    ])
    expect(jobs[0].artifact?.hash).toBe(artifactHash(required(jobs[0].artifact)))
    expect(value.runtime.verify).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        files: expect.objectContaining({
          "README.md": { mode: "100644", content: Buffer.from("npm run ci\n") },
        }),
      }),
      value.config.commands,
      expect.any(AbortSignal),
    )
    expect(value.publisher.createDraft).toHaveBeenCalledExactlyOnceWith({
      jobId: jobs[0].id,
      head: branchFor(12),
      base: "main",
      draft: true,
    })
    expect((await value.post(approval, "maintainer-approval")).status).toBe(202)
    expect((await value.post(approval, "same-transition-new-delivery")).status).toBe(202)
    await value.orchestrator.drain()
    expect(value.store.jobs()).toHaveLength(1)
    expect(value.store.claim(proposal, jobs[0].approval)).toBeUndefined()
    expect(value.runtime.code).toHaveBeenCalledTimes(1)
    expect(value.publisher.createDraft).toHaveBeenCalledTimes(1)
    expect(value.github.currentIssue.labels).toEqual(["bot:triaged", "bot:pr_ready"])
    expect(value.runtime.triage).toHaveBeenCalledTimes(1)
    expect(value.github.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(value.github.api.rest.issues.updateComment).not.toHaveBeenCalled()
    expect(value.publisher.createComment).toHaveBeenCalledTimes(1)
    expect(value.github.remoteComments).toEqual([summary, proposalComment])
    expect(JSON.stringify(dispatched)).not.toContain(rawIssueBody)
    expectNoPrivateLogs(value)
  })

  test("verifies the signature over raw bytes before sanitizing the payload", async () => {
    const value = await fixture()
    const received = vi.spyOn(value.app, "receive")
    const raw = JSON.stringify(payload({ ignored: rawCommentBody }))
    const sanitizedSignature = sign(JSON.stringify(sanitizeWebhook(JSON.parse(raw))))
    expect(
      (await value.postRaw(raw, "bad-sanitized-signature", "issues", sanitizedSignature)).status,
    ).toBe(401)
    expect((await value.postRaw(`${raw} `, "changed-raw-bytes", "issues", sign(raw))).status).toBe(
      401,
    )
    expect((await value.postRaw(raw, "malformed-signature", "issues", "invalid")).status).toBe(401)
    expect(received).not.toHaveBeenCalled()
    expect(value.store.deliveries()).toEqual([])
    expect(value.runtime.triage).not.toHaveBeenCalled()
    expectNoPrivateLogs(value)
  })

  test("sanitizes raw issue and comment bodies even when durable intake fails", async () => {
    const value = await fixture()
    const received = vi.spyOn(value.app, "receive")
    value.store.close()
    const response = await value.post(
      payload({
        action: "labeled",
        label: { name: "bot:approved" },
        comment: { body: rawCommentBody, user: { id: maintainer.id } },
      }),
      "closed-store",
    )
    expect(response.status).toBe(503)
    expect(received).toHaveBeenCalledOnce()
    const event = received.mock.calls[0][0]
    expect(event.payload).toEqual(
      sanitizeWebhook(
        payload({
          action: "labeled",
          label: { name: "bot:approved" },
          comment: { body: rawCommentBody, user: { id: maintainer.id } },
        }),
      ),
    )
    expect(value.runtime.triage).not.toHaveBeenCalled()
    expect(value.publisher.createDraft).not.toHaveBeenCalled()
    expect(value.log.error).toHaveBeenCalledExactlyOnceWith({
      event: "http_request_failed",
      reason: "webhook_intake_failed",
      method: "POST",
      route: "/api/github/webhooks",
      status: 503,
    })
    expectNoPrivateLogs(value)
  })

  test("logs one safe retryable receive failure without request or error secrets", async () => {
    const value = await fixture()
    vi.spyOn(value.app, "receive").mockRejectedValueOnce(new Error("private-receive-error"))
    const raw = JSON.stringify(payload({ ignored: "private-request-body" }))
    const response = await fetch(`${value.url}/api/github/webhooks`, {
      method: "POST",
      body: raw,
      headers: {
        "x-github-delivery": "private-delivery-id",
        "x-github-event": "issues",
        "x-hub-signature-256": sign(raw),
        authorization: "Bearer private-authorization",
        cookie: "private-cookie",
      },
    })
    expect(response.status).toBe(503)
    expect(value.log.error).toHaveBeenCalledExactlyOnceWith({
      event: "http_request_failed",
      reason: "webhook_intake_failed",
      method: "POST",
      route: "/api/github/webhooks",
      status: 503,
    })
    expect(JSON.stringify(value.log.error.mock.calls)).not.toContain("private-")
    expect(value.store.deliveries()).toEqual([])
    expectNoPrivateLogs(value)
  })

  test("does not log errors for expected webhook rejection responses", async () => {
    const value = await fixture()
    expect((await value.postRaw("{}", "bad-signature", "issues", "invalid")).status).toBe(401)
    expect((await value.postRaw("{", "invalid-json")).status).toBe(400)
    expect((await value.postRaw("{}", "invalid/delivery")).status).toBe(400)
    expect((await value.postRaw("x".repeat(1_048_577), "oversized")).status).toBe(413)
    expect((await fetch(`${value.url}/healthz`)).status).toBe(200)
    expect((await fetch(`${value.url}/private-unknown?secret=private-query`)).status).toBe(404)
    expect(value.log.error).not.toHaveBeenCalled()
  })

  test.each(["invalid JSON", "invalid ID", "oversize envelope field"])(
    "rejects signed %s without dispatch",
    async (kind) => {
      const value = await fixture()
      const received = vi.spyOn(value.app, "receive")
      let raw = "{"
      if (kind === "invalid ID") raw = JSON.stringify(payload({ issue: { id: -1, number: 12 } }))
      if (kind === "oversize envelope field")
        raw = JSON.stringify(payload({ sender: { ...maintainer, login: "x".repeat(101) } }))
      expect((await value.postRaw(raw, "invalid-envelope")).status).toBe(400)
      expect(received).not.toHaveBeenCalled()
      expect(value.store.deliveries()).toEqual([])
      expectNoPrivateLogs(value)
    },
  )

  test("rejects bodies above one MiB before signature work and accepts the exact byte limit", async () => {
    const value = await fixture()
    const verify = vi.spyOn(value.app.webhooks, "verify")
    const empty = JSON.stringify(payload({ ignored: "" }))
    const exact = JSON.stringify(
      payload({ ignored: "x".repeat(1_048_576 - Buffer.byteLength(empty)) }),
    )
    expect(Buffer.byteLength(exact)).toBe(1_048_576)
    expect((await value.postRaw(`${exact} `, "oversize-payload", "ping")).status).toBe(413)
    expect(verify).not.toHaveBeenCalled()
    expect((await value.postRaw(exact, "exact-limit", "ping")).status).toBe(202)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(value.runtime.triage).not.toHaveBeenCalled()
    expectNoPrivateLogs(value)
  })

  test.each([
    ["x-github-delivery", "bad/delivery"],
    ["x-github-delivery", "x".repeat(129)],
    ["x-github-event", "Issues"],
    ["x-github-event", "issues.opened"],
    ["x-hub-signature-256", undefined],
  ])("rejects invalid required header %s (%s)", async (name, value) => {
    const app = await fixture()
    const raw = JSON.stringify(payload())
    const headers: Record<string, string> = {
      "x-github-delivery": "header-check",
      "x-github-event": "issues",
      "x-hub-signature-256": sign(raw),
    }
    if (value === undefined) delete headers[name]
    else headers[name] = value
    const response = await fetch(`${app.url}/api/github/webhooks`, {
      method: "POST",
      headers,
      body: raw,
      signal: AbortSignal.timeout(5_000),
    })
    expect(response.status).toBe(400)
    expect(app.store.deliveries()).toEqual([])
    expectNoPrivateLogs(app)
  })

  test("exposes only health and POST webhook routes", async () => {
    const value = await fixture()
    const health = await fetch(`${value.url}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.text()).toBe("ok")
    expect((await fetch(`${value.url}/api/github/webhooks`)).status).toBe(404)
    expect((await fetch(`${value.url}/unknown`)).status).toBe(404)
    expect(value.store.deliveries()).toEqual([])
  })
})
