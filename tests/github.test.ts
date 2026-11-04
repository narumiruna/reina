import { readFileSync } from "node:fs"
import { ProbotOctokit } from "probot"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { artifactHash } from "../src/agent/validate.js"
import { authorize, revalidate } from "../src/github/approval.js"
import { Publisher, proposalBody } from "../src/github/publisher.js"
import {
  boundedList,
  branchFor,
  GitHub,
  type GitHubClient,
  GitHubDeferred,
  GitHubOutcomeUnknown,
  gitHash,
} from "../src/github/scanner.js"
import type { Job, Proposal } from "../src/types.js"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/github.json", import.meta.url), "utf8"))
const now = Date.parse(fixture.now)
const repository = fixture.repository
const bot = fixture.bot
const actor = fixture.actor
const clone = <T>(value: T): T => structuredClone(value)
const response = <T>(data: T, link?: string) => ({ data: clone(data), headers: { link } })
const apiError = (status = 500, headers: Record<string, string> = {}) =>
  Object.assign(new Error("untrusted diagnostics must not enter a comment or PR"), {
    status,
    response: { headers },
  })

type TreeEntry = { path: string; mode: string; type: string; sha: string; size?: number }
type Comment = { id: number; user: typeof bot; body: string; created_at: string }
type RawPR = {
  number: number
  user: typeof bot
  body: string
  state: string
  draft: boolean
  html_url: string
  merged_at: string | null
  head: { ref: string; sha: string; repo: { id: number } }
  base: { ref: string; sha: string; repo: { id: number } }
}
type RawCommit = {
  sha: string
  tree: { sha: string }
  parents: { sha: string }[]
  message: string
  author: { name: string; email: string; date: string }
  committer: { name: string; email: string; date: string }
}

function treeHash(entries: TreeEntry[]): string {
  return gitHash(
    "tree",
    Buffer.concat(
      [...entries]
        .sort((a, b) => a.path.localeCompare(b.path))
        .flatMap((entry) => [
          Buffer.from(`${entry.mode} ${entry.path}\0`),
          Buffer.from(entry.sha, "hex"),
        ]),
    ),
  )
}

class MockAPI {
  auth = { tokenType: "installation", installationId: repository.installationId }
  metadata = {
    id: repository.id,
    name: repository.name,
    owner: { login: repository.owner },
    default_branch: "main",
  }
  issue = clone(fixture.issue)
  comments: Comment[] = clone(fixture.comments)
  events = clone(fixture.events)
  permission = "write"
  bot = clone(bot)
  prs: RawPR[] = []
  refs = new Map<string, string>([["main", fixture.baseSha]])
  blobs = new Map<string, Buffer>()
  commits = new Map<string, RawCommit>()
  entries: TreeEntry[]
  truncated = false
  trace: string[] = []
  fault?: { method: string; when: "before" | "after"; remaining: number }
  commentsLink?: string
  eventsLink?: string
  prsLink?: string

  constructor() {
    const bytes = Buffer.from(fixture.baseContent)
    const sha = gitHash("blob", bytes)
    this.blobs.set(sha, bytes)
    this.entries = [{ path: "README.md", mode: "100644", type: "blob", sha, size: bytes.length }]
  }

  fail(method: string, when: "before" | "after" = "after", remaining = 1) {
    this.fault = { method, when, remaining }
  }

  private method<P, R>(name: string, implementation: (params: P) => R) {
    return vi.fn(async (params: P) => {
      this.trace.push(name)
      const fail = this.fault?.method === name && this.fault.remaining > 0
      if (fail && this.fault?.when === "before") {
        this.fault.remaining--
        throw apiError()
      }
      const result = implementation(params)
      if (fail && this.fault?.when === "after") {
        this.fault.remaining--
        throw apiError()
      }
      return result
    })
  }

  rest = {
    repos: {
      get: this.method("repos.get", () => response(this.metadata)),
      getCollaboratorPermissionLevel: this.method("repos.permission", () =>
        response({ permission: this.permission, user: actor }),
      ),
    },
    issues: {
      get: this.method("issues.get", () =>
        response({ ...this.issue, comments: this.comments.length }),
      ),
      listComments: this.method("issues.listComments", () =>
        response(this.comments, this.commentsLink),
      ),
      listEvents: this.method("issues.listEvents", () => response(this.events, this.eventsLink)),
      listForRepo: this.method("issues.listForRepo", () => response([this.issue])),
      createComment: this.method("issues.createComment", (params: { body: string }) => {
        const comment = {
          id: this.comments.length + 100,
          user: bot,
          body: params.body,
          created_at: fixture.now,
        }
        this.comments.push(comment)
        return response(comment)
      }),
      addLabels: this.method("issues.addLabels", (params: { labels: string[] }) => {
        this.issue.labels = [...new Set([...this.issue.labels, ...params.labels])]
        return response(this.issue.labels)
      }),
      removeLabel: this.method("issues.removeLabel", (params: { name: string }) => {
        this.issue.labels = this.issue.labels.filter((label: string) => label !== params.name)
        return response(this.issue.labels)
      }),
    },
    users: { getById: this.method("users.getById", () => response(this.bot)) },
    git: {
      getRef: this.method("git.getRef", (params: { ref: string }) => {
        const sha = this.refs.get(params.ref.replace(/^heads\//, ""))
        if (!sha) throw apiError(404)
        return response({ ref: `refs/${params.ref}`, object: { type: "commit", sha } })
      }),
      getCommit: this.method("git.getCommit", (params: { commit_sha: string }) => {
        if (params.commit_sha === fixture.baseSha) {
          return response({ sha: fixture.baseSha, tree: { sha: treeHash(this.entries) } })
        }
        const commit = this.commits.get(params.commit_sha)
        if (!commit) throw apiError(404)
        return response(commit)
      }),
      getTree: this.method("git.getTree", () =>
        response({ sha: treeHash(this.entries), tree: this.entries, truncated: this.truncated }),
      ),
      getBlob: this.method("git.getBlob", (params: { file_sha: string }) => {
        const content = this.blobs.get(params.file_sha)
        if (!content) throw apiError(404)
        return response({
          sha: params.file_sha,
          encoding: "base64",
          content: content.toString("base64"),
          size: content.length,
        })
      }),
      createBlob: this.method("git.createBlob", (params: { content: string; encoding: string }) => {
        expect(params.encoding).toBe("base64")
        const content = Buffer.from(params.content, "base64")
        const sha = gitHash("blob", content)
        this.blobs.set(sha, content)
        return response({ sha })
      }),
      createTree: this.method(
        "git.createTree",
        (params: { base_tree: string; tree: (TreeEntry & { sha: string | null })[] }) => {
          expect(params.base_tree).toBe(treeHash(this.entries))
          const tree = clone(this.entries)
          for (const entry of params.tree) {
            const index = tree.findIndex((existing) => existing.path === entry.path)
            if (index !== -1) tree.splice(index, 1)
            if (entry.sha) tree.push(entry)
          }
          return response({ sha: treeHash(tree), tree, truncated: false })
        },
      ),
      createCommit: this.method(
        "git.createCommit",
        (params: {
          tree: string
          parents: string[]
          message: string
          author: RawCommit["author"]
          committer: RawCommit["committer"]
        }) => {
          const person = (who: RawCommit["author"]) =>
            `${who.name} <${who.email}> ${Date.parse(who.date) / 1000} +0000`
          const raw = `tree ${params.tree}\nparent ${params.parents[0]}\nauthor ${person(params.author)}\ncommitter ${person(params.committer)}\n\n${params.message}`
          const sha = gitHash("commit", Buffer.from(raw))
          const commit = {
            ...params,
            sha,
            tree: { sha: params.tree },
            parents: params.parents.map((parent) => ({ sha: parent })),
          }
          this.commits.set(sha, commit)
          return response(commit)
        },
      ),
      createRef: this.method("git.createRef", (params: { ref: string; sha: string }) => {
        const branch = params.ref.replace(/^refs\/heads\//, "")
        if (this.refs.has(branch)) throw apiError(422)
        this.refs.set(branch, params.sha)
        return response({ ref: params.ref, object: { type: "commit", sha: params.sha } })
      }),
    },
    pulls: {
      list: this.method("pulls.list", () => response(this.prs, this.prsLink)),
      get: this.method("pulls.get", (params: { pull_number: number }) => {
        const pr = this.prs.find((candidate) => candidate.number === params.pull_number)
        if (!pr) throw apiError(404)
        return response(pr)
      }),
      create: this.method(
        "pulls.create",
        (params: { head: string; base: string; body: string; draft: boolean }) => {
          const pr = {
            number: 40,
            user: bot,
            body: params.body,
            draft: params.draft,
            state: "open",
            merged_at: null,
            html_url: `https://github.com/${repository.owner}/${repository.name}/pull/40`,
            head: {
              ref: params.head,
              repo: { id: repository.id },
              sha: this.refs.get(params.head) ?? "",
            },
            base: { ref: params.base, repo: { id: repository.id }, sha: fixture.baseSha },
          }
          this.prs.push(pr)
          return response(pr)
        },
      ),
    },
  }

  client(): GitHubClient {
    return { rest: this.rest, auth: vi.fn(async () => this.auth) } as unknown as GitHubClient
  }
}

function proposal(): Proposal {
  return {
    revision: "a".repeat(64),
    ref: { ...repository, number: fixture.issue.number, issueId: fixture.issue.id },
    fingerprint: "f".repeat(64),
    baseBranch: "main",
    baseSha: fixture.baseSha,
    decision: {
      eligible: true,
      category: "documentation",
      reason: "The documented result is wrong.",
      proposedFix: "Correct the documented result",
      affectedFiles: ["README.md"],
      verificationPlan: ["Run the configured check"],
      requiresHumanDecision: false,
      risks: ["Review the documented result."],
    },
    commands: [["npm", "test", "--", "--run"]],
    policyHash: "b".repeat(64),
    image: "worker@sha256:abc",
    createdAt: Date.parse("2026-11-03T10:00:00Z"),
    expiresAt: now + 60_000,
    commentId: 20,
    publishedAt: Date.parse("2026-11-03T10:01:00Z"),
  }
}

function job(p = proposal()): Job {
  const current: Job = {
    id: "job-1",
    ref: p.ref,
    proposalRevision: p.revision,
    state: "publishing",
    createdAt: now + 123,
    updatedAt: now,
    approval: {
      eventId: "1002",
      actor,
      proposalRevision: p.revision,
      createdAt: now - 60_000,
      permission: "write",
    },
    artifact: {
      files: [
        {
          path: "README.md",
          content: Buffer.from(fixture.changedContent).toString("base64"),
          mode: "100644",
        },
      ],
      diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-Original.\n+Correct.\n",
      hash: "",
      verification: [{ argv: p.commands[0], exitCode: 0, durationMs: 15, image: p.image }],
    },
  }
  if (current.artifact) current.artifact.hash = artifactHash(current.artifact)
  return current
}

function setup(approved = false) {
  const api = new MockAPI()
  if (approved) {
    const p = proposal()
    api.comments.push({
      id: p.commentId ?? 0,
      user: bot,
      body: proposalBody(p),
      created_at: new Date(p.publishedAt ?? 0).toISOString(),
    })
  }
  const client = api.client()
  return {
    api,
    github: new GitHub(client, repository, bot.id),
    publisher: new Publisher(client, repository, bot.id),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("bounded GitHub reads", () => {
  test("reads only the allowlisted installation and numeric repository", async () => {
    const { api, github } = setup()
    api.auth.installationId++
    await expect(github.issue(12)).rejects.toMatchObject({
      code: "github_installation_not_allowed",
    })
    expect(api.rest.repos.get).not.toHaveBeenCalled()
    api.auth.installationId--
    api.metadata.id++
    await expect(github.snapshot()).rejects.toMatchObject({ code: "github_repository_not_allowed" })
    expect(api.rest.git.getRef).not.toHaveBeenCalled()
  })

  test.each(["token", "repository", "broad-scope", "installation", "expiry"])(
    "rejects invalid scoped-token attestation: %s",
    async (kind) => {
      const api = new MockAPI()
      const client = api.client()
      const token = "ghs_fixture_not_real"
      vi.mocked(client.auth).mockResolvedValue({ token, tokenType: "installation" })
      const identity = {
        token,
        tokenType: "installation" as const,
        installationId: repository.installationId,
        repositoryIds: [repository.id],
        expiresAt: new Date(now + 3_600_000).toISOString(),
      }
      if (kind === "token") identity.token = "ghs_other"
      if (kind === "repository") identity.repositoryIds = [999]
      if (kind === "broad-scope") identity.repositoryIds.push(999)
      if (kind === "installation") identity.installationId++
      if (kind === "expiry") identity.expiresAt = new Date(now).toISOString()
      await expect(new GitHub(client, repository, bot.id, identity).head()).rejects.toMatchObject({
        code: "github_installation_not_allowed",
      })
      expect(api.rest.repos.get).not.toHaveBeenCalled()
    },
  )

  test.each(["owner", "name"])("rejects a renamed repository %s", async (field) => {
    const { api, github } = setup()
    if (field === "owner") api.metadata.owner.login = "other"
    else api.metadata.name = "other"
    await expect(github.discover(10)).rejects.toMatchObject({
      code: "github_repository_not_allowed",
    })
  })

  test("reads issue context and excludes only Reina's numeric author", async () => {
    const { github } = setup()
    const issue = await github.issue(12)
    expect(issue.ref).toEqual({ ...repository, number: 12, issueId: 123 })
    expect(issue.comments).toEqual([{ id: 1, authorId: actor.id, body: fixture.comments[0].body }])
  })

  test.each(["comments", "context", "incomplete", "duplicate"])(
    "fails closed on %s evidence",
    async (kind) => {
      const { api, github } = setup()
      if (kind === "comments")
        api.comments = Array.from({ length: 101 }, (_, i) => ({ ...api.comments[0], id: i + 1 }))
      if (kind === "context") api.issue.body = "a".repeat(128 * 1024)
      if (kind === "incomplete") api.commentsLink = '<https://api.github.test/page=2>; rel="next"'
      if (kind === "duplicate") api.comments[1].id = api.comments[0].id
      await expect(github.issue(12)).rejects.toThrow()
      if (kind === "comments") expect(api.rest.issues.listComments).not.toHaveBeenCalled()
    },
  )

  test("uses repos.get for the current default branch; head does not read files", async () => {
    const { api, github } = setup()
    api.metadata.default_branch = "trunk"
    api.refs.set("trunk", fixture.baseSha)
    expect(await github.head()).toEqual({ branch: "trunk", sha: fixture.baseSha })
    expect(api.rest.git.getBlob).not.toHaveBeenCalled()
    const snapshot = await github.snapshot()
    expect(snapshot.branch).toBe("trunk")
    expect(snapshot.files["README.md"].content.toString()).toBe(fixture.baseContent)
  })

  test("snapshotAt reads the exact approved commit without consulting the branch ref", async () => {
    const { api, github } = setup()
    api.refs.set("main", "2".repeat(40))
    expect((await github.snapshotAt("main", fixture.baseSha)).sha).toBe(fixture.baseSha)
    expect(api.rest.git.getRef).not.toHaveBeenCalled()
  })

  test.each([
    "truncated",
    "symlink",
    "gitlink",
    "unsafe",
    "duplicate",
    "missing-parent",
    "size",
    "count",
    "total",
  ])("rejects %s trees before downloading any blobs", async (kind) => {
    const { api, github } = setup()
    if (kind === "truncated") api.truncated = true
    if (kind === "symlink") api.entries[0].mode = "120000"
    if (kind === "gitlink") {
      api.entries[0].mode = "160000"
      api.entries[0].type = "commit"
    }
    if (kind === "unsafe") api.entries[0].path = "../README.md"
    if (kind === "duplicate") api.entries.push(clone(api.entries[0]))
    if (kind === "missing-parent") api.entries[0].path = "missing/README.md"
    if (kind === "size") api.entries[0].size = 1024 * 1024 + 1
    if (kind === "count")
      api.entries = Array.from({ length: 2001 }, (_, i) => ({
        ...api.entries[0],
        path: `file-${i}`,
      }))
    if (kind === "total")
      api.entries = Array.from({ length: 17 }, (_, i) => ({
        ...api.entries[0],
        path: `file-${i}`,
        size: 1024 * 1024,
      }))
    await expect(github.snapshot()).rejects.toThrow()
    expect(api.rest.git.getBlob).not.toHaveBeenCalled()
  })

  test.each(["/absolute", "C:/drive", "a\\b", "a//b", "a/./b", ".git/config", "a/../b", "nul\0"])(
    "rejects unsafe snapshot path %s",
    async (path) => {
      const { api, github } = setup()
      api.entries[0].path = path
      await expect(github.snapshot()).rejects.toMatchObject({ code: "github_unsafe_tree" })
    },
  )

  test.each(["encoding", "size", "hash", "invalid-base64"])(
    "verifies raw blob %s",
    async (kind) => {
      const { api, github } = setup()
      const bytes = Buffer.from(fixture.baseContent)
      api.rest.git.getBlob.mockResolvedValueOnce(
        response({
          sha: api.entries[0].sha,
          encoding: kind === "encoding" ? "utf-8" : "base64",
          size: kind === "size" ? bytes.length + 1 : bytes.length,
          content:
            kind === "hash"
              ? Buffer.from("Malicious!\n").toString("base64")
              : kind === "invalid-base64"
                ? "a==not-base64"
                : bytes.toString("base64"),
        }),
      )
      await expect(github.snapshot()).rejects.toThrow()
    },
  )

  test("accepts wrapped base64 and executable regular files", async () => {
    const { api, github } = setup()
    api.entries[0].mode = "100755"
    const body = Buffer.from(fixture.baseContent)
    api.rest.git.getBlob.mockResolvedValueOnce(
      response({
        sha: api.entries[0].sha,
        encoding: "base64",
        size: body.length,
        content: `${body.toString("base64").slice(0, 4)}\n${body.toString("base64").slice(4)}\n`,
      }),
    )
    expect((await github.snapshot()).files["README.md"].mode).toBe("100755")
  })

  test("discovers only open non-PR issues without bot:skip, with bounded pages", async () => {
    const { api, github } = setup()
    api.rest.issues.listForRepo.mockResolvedValueOnce(
      response(
        [
          { ...api.issue, number: 1, pull_request: {} },
          { ...api.issue, number: 2, state: "closed" },
          { ...api.issue, number: 3, labels: ["bot:skip"] },
        ],
        '<https://api.github.test/?page=2>; rel="next"',
      ),
    )
    expect(await github.discover(3, 1)).toEqual({ numbers: [], nextPage: 2 })
    expect(await github.discover(3, 2)).toEqual({ numbers: [12], nextPage: 1 })
    expect(api.rest.issues.listForRepo).toHaveBeenCalledTimes(2)
    expect(api.rest.issues.listForRepo.mock.calls[1][0]).toMatchObject({ page: 2, per_page: 3 })
    await expect(github.discover(101)).rejects.toThrow()
    await expect(github.discover(3, 0)).rejects.toThrow()
  })

  test("history reads all bounded pages and rejects duplicate or incomplete history", async () => {
    const { api, github } = setup()
    api.rest.issues.listEvents.mockResolvedValueOnce(
      response([api.events[0]], '<https://api.github.test/?page=2>; rel="next"'),
    )
    api.rest.issues.listEvents.mockResolvedValueOnce(response([api.events[1]]))
    expect((await github.history(12)).map((event) => event.id)).toEqual(["1001", "1002"])
    api.events.push(clone(api.events[1]))
    await expect(github.history(12)).rejects.toMatchObject({ code: "github_ambiguous_history" })
  })

  test("bounds pagination even when a server never supplies a last page", async () => {
    const read = vi.fn(async () => response([{}], '<https://evil.test>; rel="next"'))
    await expect(boundedList(read, 1000)).rejects.toBeInstanceOf(GitHubDeferred)
    expect(read).toHaveBeenCalledTimes(10)
  })

  test("retries transient reads at most three times, without waiting", async () => {
    const { api, github } = setup()
    api.fail("repos.get", "before", 4)
    await expect(github.head()).rejects.toMatchObject({ code: "github_read_retry_exhausted" })
    expect(api.rest.repos.get).toHaveBeenCalledTimes(4)
    expect(Date.now()).toBe(now)
  })

  test.each([403, 429, 503])(
    "defers %s Retry-After without sleeping or retrying",
    async (status) => {
      const { api, github } = setup()
      api.rest.repos.get.mockRejectedValueOnce(
        apiError(status, { "retry-after": "120", "x-ratelimit-reset": `${now / 1000 + 200}` }),
      )
      await expect(github.head()).rejects.toMatchObject({
        code: "github_rate_limit",
        retryAt: now + 201_000,
      })
      expect(api.rest.repos.get).toHaveBeenCalledTimes(1)
      expect(Date.now()).toBe(now)
    },
  )

  test("uses the installed Probot REST client against a local fake fetch only", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "rate limit exceeded" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "30" },
        }),
    )
    const client = new ProbotOctokit({
      auth: { token: "ghs_test_fixture_not_a_real_token" },
      throttle: { enabled: false },
      retry: { enabled: false },
      request: { fetch },
    })
    const github = new GitHub(client, repository, bot.id, {
      token: "ghs_test_fixture_not_a_real_token",
      tokenType: "installation",
      installationId: repository.installationId,
      repositoryIds: [repository.id],
      expiresAt: new Date(now + 3_600_000).toISOString(),
    })
    await expect(github.head()).rejects.toMatchObject({
      code: "github_rate_limit",
      retryAt: now + 30_000,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test("checks deterministic branch and exact head PRs in all states", async () => {
    const { api, github } = setup()
    expect(await github.conflicts(12)).toBe(false)
    api.refs.set(branchFor(12), fixture.baseSha)
    expect(await github.conflicts(12)).toBe(true)
    expect(api.rest.pulls.list).toHaveBeenLastCalledWith(
      expect.objectContaining({
        head: `${repository.owner}:${branchFor(12)}`,
        state: "all",
        per_page: 100,
      }),
    )
    api.refs.delete(branchFor(12))
    api.rest.pulls.list.mockResolvedValueOnce(response([{ state: "closed" } as RawPR]))
    expect(await github.conflicts(12)).toBe(true)
  })
})

describe("approval authority", () => {
  test("observed close/reopen history revokes authority even when both webhooks are missing", async () => {
    const { api, github } = setup(true)
    const p = proposal()
    const issued = await authorize(github, await github.issue(12), p, actor)
    api.events.push({
      id: 3000,
      event: "closed",
      created_at: new Date(now - 1000).toISOString(),
      actor,
    })
    api.events.push({ id: 3001, event: "reopened", created_at: new Date(now).toISOString(), actor })
    expect((await github.history(12)).map((item) => item.event)).toContain("closed")
    await expect(revalidate(github, await github.issue(12), p, issued)).rejects.toMatchObject({
      code: "approval_issue_lifecycle_changed",
    })
    await expect(authorize(github, await github.issue(12), p, actor)).rejects.toMatchObject({
      code: "approval_issue_lifecycle_changed",
    })
  })

  test("binds the latest human label event, revision, and effective permission", async () => {
    const { github } = setup(true)
    const approval = await authorize(github, await github.issue(12), proposal(), actor)
    expect(approval).toEqual({
      eventId: "1002",
      actor,
      proposalRevision: "a".repeat(64),
      createdAt: now - 60_000,
      permission: "write",
    })
  })

  test.each(["read", "triage", "none", "custom-role"])(
    "rejects permission %s",
    async (permission) => {
      const { api, github } = setup(true)
      api.permission = permission
      await expect(
        authorize(github, await github.issue(12), proposal(), actor),
      ).rejects.toMatchObject({ code: "approval_permission_denied" })
    },
  )

  test.each([
    "bot",
    "app",
    "wrong-actor",
    "old",
    "tie",
    "future",
    "revoked",
    "skip-revoked",
    "proposal-revoked",
    "ambiguous",
  ])("rejects %s approval transitions", async (kind) => {
    const { api, github } = setup(true)
    const p = proposal()
    const event = api.events[1]
    let sender = clone(actor)
    if (kind === "bot") event.actor = bot
    if (kind === "app") event.actor.type = "Organization"
    if (kind === "wrong-actor") sender = { ...actor, id: 999 }
    if (kind === "old") event.created_at = "2026-11-03T09:00:00Z"
    if (kind === "tie") event.created_at = new Date(p.publishedAt ?? 0).toISOString()
    if (kind === "future") event.created_at = new Date(now + 1000).toISOString()
    if (kind === "revoked")
      api.events.push({ ...event, id: 1003, event: "unlabeled", created_at: fixture.now })
    if (kind === "skip-revoked")
      api.events.push({ ...event, id: 1003, label: { name: "bot:skip" }, created_at: fixture.now })
    if (kind === "proposal-revoked")
      api.events.push({
        ...event,
        id: 1003,
        event: "unlabeled",
        label: { name: "fix_available" },
        created_at: fixture.now,
      })
    if (kind === "ambiguous") api.events.push({ ...event, id: 1003 })
    await expect(authorize(github, await github.issue(12), p, sender)).rejects.toThrow()
  })

  test.each([
    "closed",
    "pr",
    "skip",
    "no-proposal-label",
    "no-approval-label",
    "expired",
    "unpublished",
    "repository",
    "issue-id",
    "branch",
  ])("rejects %s issues and proposals", async (kind) => {
    const { api, github } = setup(true)
    const p = proposal()
    const issue = await github.issue(12)
    if (kind === "closed") issue.state = "closed"
    if (kind === "pr") issue.pullRequest = true
    if (kind === "skip") issue.labels.push("bot:skip")
    if (kind === "no-proposal-label") issue.labels = ["bot:approved"]
    if (kind === "no-approval-label") issue.labels = ["fix_available"]
    if (kind === "expired") p.expiresAt = now
    if (kind === "unpublished") delete p.commentId
    if (kind === "repository") p.ref = { ...p.ref, id: 999 }
    if (kind === "issue-id") p.ref = { ...p.ref, issueId: 999 }
    if (kind === "branch") api.refs.set(branchFor(12), fixture.baseSha)
    await expect(authorize(github, issue, p, actor)).rejects.toThrow()
  })

  test("revalidation ignores its own publication branch but rejects replacement events and revoked permission", async () => {
    const { api, github } = setup(true)
    const p = proposal()
    const issue = await github.issue(12)
    const approval = await authorize(github, issue, p, actor)
    api.refs.set(branchFor(12), fixture.baseSha)
    await expect(revalidate(github, issue, p, approval)).resolves.toBeUndefined()
    api.permission = "read"
    await expect(revalidate(github, issue, p, approval)).rejects.toThrow()
    api.permission = "write"
    api.events.push({ ...api.events[1], id: 1003, created_at: fixture.now })
    await expect(revalidate(github, issue, p, approval)).rejects.toMatchObject({
      code: "approval_event_replaced",
    })
  })
})

describe("live proposal publication authority", () => {
  test("binds permission to the actor numeric ID, not a reused login", async () => {
    const { api, github } = setup(true)
    api.rest.repos.getCollaboratorPermissionLevel.mockResolvedValueOnce(
      response({ permission: "write", user: { ...actor, id: 999 } }),
    )
    await expect(
      authorize(github, await github.issue(12), proposal(), actor),
    ).rejects.toMatchObject({ code: "github_permission_mismatch" })
  })

  test.each(["deleted", "edited", "foreign-author", "timestamp"])(
    "rejects a %s published comment",
    async (kind) => {
      const { api, github } = setup(true)
      const p = proposal()
      if (kind === "deleted") api.comments.pop()
      if (kind === "edited") api.comments[2].body += " changed"
      if (kind === "foreign-author") api.comments[2].user = actor
      if (kind === "timestamp") api.comments[2].created_at = fixture.now
      await expect(authorize(github, await github.issue(12), p, actor)).rejects.toMatchObject({
        code: "approval_proposal_comment_changed",
      })
    },
  )

  test("revalidation rejects proposal deletion even though the issue fingerprint excludes Reina comments", async () => {
    const { api, github } = setup(true)
    const p = proposal()
    const issue = await github.issue(12)
    const approval = await authorize(github, issue, p, actor)
    api.comments.pop()
    await expect(revalidate(github, await github.issue(12), p, approval)).rejects.toMatchObject({
      code: "approval_proposal_comment_changed",
    })
  })
})

describe("proposal comments and labels", () => {
  test("the trusted App cannot grant its own human approval label", async () => {
    const { api, publisher } = setup()
    await expect(publisher.labels(12, ["bot:approved"], [])).rejects.toMatchObject({
      code: "publication_invalid_labels",
    })
    expect(api.rest.issues.addLabels).not.toHaveBeenCalled()
  })

  test("untrusted proposal text cannot embed active Markdown images, HTML, or mentions", () => {
    const value = proposal()
    value.decision.reason = "![private](https://attacker.invalid/pixel) <img src=x> @maintainer"
    const body = proposalBody(value)
    expect(body).toContain("\\!\\[private\\]\\(https://attacker.invalid/pixel\\)")
    expect(body).not.toContain("![private](")
    expect(body).not.toContain("<img")
    expect(body).not.toContain("@maintainer")
  })

  test("publishes immutable revision markers and does not trust copied human markers", async () => {
    const { api, publisher } = setup()
    const p = proposal()
    const saves: Proposal[] = []
    const first = await publisher.propose(p, (saved) => {
      saves.push(clone(saved))
      expect(api.rest.issues.createComment).not.toHaveBeenCalled()
    })
    expect(saves[0].commentIntent).toBe(true)
    const appComment = clone(api.comments.at(-1))
    expect(appComment?.body).toContain("read-only assessment")
    expect(await publisher.propose(p)).toEqual(first)
    expect(api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    const next = proposal()
    next.revision = "b".repeat(64)
    api.comments.push({
      ...(api.comments.at(-1) as Comment),
      id: 500,
      user: actor,
      body: (appComment?.body ?? "").replaceAll(p.revision, next.revision),
    })
    await publisher.propose(next)
    expect(api.rest.issues.createComment).toHaveBeenCalledTimes(2)
    expect(api.comments[2].body).toBe(appComment?.body)
  })

  test("reconciles an accepted comment after a lost response", async () => {
    const { api, publisher } = setup()
    api.fail("issues.createComment")
    const p = proposal()
    const result = await publisher.propose(p)
    expect(result.commentId).toBe(api.comments.at(-1)?.id)
    await publisher.propose(p)
    expect(api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("persists comment intent and blocks retry when acceptance cannot be proved", async () => {
    const { api, publisher } = setup()
    api.fail("issues.createComment", "before")
    const p = proposal()
    await expect(publisher.propose(p)).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    const restarted = new Publisher(api.client(), repository, bot.id)
    await expect(restarted.propose(clone(p))).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    expect(api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("a crash after durable comment intent does not cause another POST", async () => {
    const { api, publisher } = setup()
    const p = proposal()
    await expect(
      publisher.propose(p, () => {
        throw new Error("crash")
      }),
    ).rejects.toThrow("crash")
    expect(api.rest.issues.createComment).not.toHaveBeenCalled()
    await expect(new Publisher(api.client(), repository, bot.id).propose(p)).rejects.toBeInstanceOf(
      GitHubOutcomeUnknown,
    )
  })

  test("rejects changed App-owned revision comments and incomplete reconciliation", async () => {
    const { api, publisher } = setup()
    const p = proposal()
    await publisher.propose(p)
    api.comments[2].body += "\nmodified"
    await expect(publisher.propose(p)).rejects.toMatchObject({
      code: "publication_comment_conflict",
    })
    api.commentsLink = '<https://api.github.test/?page=2>; rel="next"'
    await expect(publisher.propose(p)).rejects.toThrow()
    expect(api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("label writes are idempotent and never remove the maintainer exclusion", async () => {
    const { api, publisher } = setup()
    api.fail("issues.addLabels")
    await expect(publisher.labels(12, ["bot:working"], ["fix_available"])).rejects.toThrow()
    await publisher.labels(12, ["bot:working"], ["fix_available"])
    await publisher.labels(12, ["bot:working"], ["fix_available"])
    expect(api.rest.issues.addLabels).toHaveBeenCalledTimes(1)
    expect(api.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
    await expect(publisher.labels(12, [], ["bot:skip"])).rejects.toMatchObject({
      code: "publication_invalid_labels",
    })
  })
})

describe("publication retry authorization", () => {
  function operation(kind: "comment" | "PR") {
    const { api, publisher } = setup()
    const p = proposal()
    delete p.commentId
    delete p.publishedAt
    let durableProposal = clone(p)
    let durableJob = job(p)
    let saveFault: "grant" | "consume" | undefined
    const post = kind === "comment" ? api.rest.issues.createComment : api.rest.pulls.create
    const commentPost = api.rest.issues.createComment.getMockImplementation()
    const prPost = api.rest.pulls.create.getMockImplementation()
    if (!commentPost || !prPost) throw new Error("Missing mock implementation")
    const checkSave = (previous: number | undefined, next: number | undefined) => {
      if (
        (saveFault === "grant" && next !== undefined) ||
        (saveFault === "consume" && previous !== undefined && next === undefined)
      )
        throw new Error("save failed")
    }
    const saveProposal = (saved: Proposal) => {
      checkSave(durableProposal.commentRetryAt, saved.commentRetryAt)
      durableProposal = clone(saved)
    }
    const saveJob = (saved: Job) => {
      checkSave(durableJob.publication?.prRetryAt, saved.publication?.prRetryAt)
      durableJob = clone(saved)
    }
    return {
      api,
      publisher,
      post,
      accept: () =>
        kind === "comment"
          ? commentPost(api.rest.issues.createComment.mock.calls[0][0])
          : prPost(api.rest.pulls.create.mock.calls[0][0]),
      beforePost(check: () => void) {
        if (kind === "comment") {
          api.rest.issues.createComment.mockImplementationOnce(async (params) => {
            check()
            return commentPost(params)
          })
        } else {
          api.rest.pulls.create.mockImplementationOnce(async (params) => {
            check()
            return prPost(params)
          })
        }
      },
      failSave: (phase?: "grant" | "consume") => {
        saveFault = phase
      },
      retryAt: () =>
        kind === "comment" ? durableProposal.commentRetryAt : durableJob.publication?.prRetryAt,
      intent: () =>
        kind === "comment" ? durableProposal.commentIntent : durableJob.publication?.prIntent,
      run: (current = publisher) =>
        kind === "comment"
          ? current.propose(clone(durableProposal), saveProposal)
          : current.publish(durableJob, p, saveJob),
    }
  }

  test.each([
    ["comment", 403, false],
    ["comment", 403, true],
    ["comment", 429, false],
    ["comment", 429, true],
    ["PR", 403, false],
    ["PR", 403, true],
    ["PR", 429, false],
    ["PR", 429, true],
  ] as const)("%s retries confirmed %s once (restart=%s)", async (kind, status, restart) => {
    const op = operation(kind)
    op.post.mockRejectedValueOnce(apiError(status, { "retry-after": "1" }))
    await expect(op.run()).rejects.toMatchObject({ retryAt: now + 1000 })
    expect(op.retryAt()).toBe(now + 1000)
    expect(op.intent()).toBe(true)
    const current = restart ? new Publisher(op.api.client(), repository, bot.id) : op.publisher
    await expect(op.run(current)).rejects.toMatchObject({ retryAt: now + 1000 })
    expect(op.post).toHaveBeenCalledTimes(1)
    vi.setSystemTime(now + 1000)
    op.beforePost(() => {
      expect(op.retryAt()).toBeUndefined()
      expect(op.intent()).toBe(true)
    })
    await op.run(current)
    expect(op.retryAt()).toBeUndefined()
    expect(op.post).toHaveBeenCalledTimes(2)
  })

  test.each(["comment", "PR"] as const)(
    "%s consumes authorization even when retry acceptance is hidden",
    async (kind) => {
      const op = operation(kind)
      op.post.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
      await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
      expect(op.retryAt()).toBe(now + 1000)
      vi.setSystemTime(now + 1000)
      if (kind === "comment") {
        op.api.fail("issues.createComment", "after")
        op.api.rest.issues.listComments.mockResolvedValueOnce(response([]))
        op.api.rest.issues.listComments.mockResolvedValueOnce(response([]))
      } else {
        op.api.fail("pulls.create", "after")
        for (let i = 0; i < 3; i++) op.api.rest.pulls.list.mockResolvedValueOnce(response([]))
      }
      await expect(op.run()).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
      expect(op.retryAt()).toBeUndefined()
      const restarted = new Publisher(op.api.client(), repository, bot.id)
      if (kind === "comment") op.api.rest.issues.listComments.mockResolvedValueOnce(response([]))
      else op.api.rest.pulls.list.mockResolvedValueOnce(response([]))
      await expect(op.run(restarted)).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
      expect(op.post).toHaveBeenCalledTimes(2)
      await op.run(restarted)
      expect(op.post).toHaveBeenCalledTimes(2)
    },
  )

  test.each(["comment", "PR"] as const)(
    "%s never grants a retry for 503 with Retry-After",
    async (kind) => {
      const op = operation(kind)
      op.post.mockRejectedValueOnce(apiError(503, { "retry-after": "1" }))
      await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
      expect(op.retryAt()).toBeUndefined()
      vi.setSystemTime(now + 1000)
      await expect(op.run()).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
      await expect(
        op.run(new Publisher(op.api.client(), repository, bot.id)),
      ).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
      expect(op.post).toHaveBeenCalledTimes(1)
    },
  )

  test.each(["comment", "PR"] as const)("%s fails closed on grant save failure", async (kind) => {
    const op = operation(kind)
    op.failSave("grant")
    op.post.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(op.run()).rejects.toThrow("save failed")
    expect(op.retryAt()).toBeUndefined()
    expect(op.intent()).toBe(true)
    op.failSave()
    vi.setSystemTime(now + 1000)
    await expect(op.run()).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    await expect(op.run(new Publisher(op.api.client(), repository, bot.id))).rejects.toBeInstanceOf(
      GitHubOutcomeUnknown,
    )
    expect(op.post).toHaveBeenCalledTimes(1)
  })

  test.each(["comment", "PR"] as const)("%s needs durable grant consumption", async (kind) => {
    const op = operation(kind)
    op.post.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
    op.failSave("consume")
    vi.setSystemTime(now + 1000)
    await expect(op.run()).rejects.toThrow("save failed")
    expect(op.post).toHaveBeenCalledTimes(1)
    op.failSave()
    await op.run(new Publisher(op.api.client(), repository, bot.id))
    expect(op.post).toHaveBeenCalledTimes(2)
  })

  test.each(["comment", "PR"] as const)("%s reconciles before the retry deadline", async (kind) => {
    const op = operation(kind)
    op.post.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
    await op.accept()
    await op.run(new Publisher(op.api.client(), repository, bot.id))
    expect(op.retryAt()).toBeUndefined()
    expect(op.post).toHaveBeenCalledTimes(1)
  })

  test.each(["comment", "PR"] as const)("%s keeps its grant on a read deferral", async (kind) => {
    const op = operation(kind)
    op.post.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
    const read = kind === "comment" ? op.api.rest.issues.listComments : op.api.rest.pulls.list
    read.mockRejectedValueOnce(apiError(429, { "retry-after": "3600" }))
    await expect(op.run()).rejects.toMatchObject({ retryAt: now + 3_600_000 })
    expect(op.retryAt()).toBe(now + 1000)
    expect(op.post).toHaveBeenCalledTimes(1)
    vi.setSystemTime(now + 1000)
    await op.run()
    expect(op.post).toHaveBeenCalledTimes(2)
  })

  test.each(["comment", "PR"] as const)("%s renews a grant only after rejection", async (kind) => {
    const op = operation(kind)
    op.post.mockRejectedValueOnce(apiError(403, { "retry-after": "1" }))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
    vi.setSystemTime(now + 1000)
    op.post.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
    expect(op.retryAt()).toBe(now + 2000)
    vi.setSystemTime(now + 2000)
    await op.run()
    expect(op.post).toHaveBeenCalledTimes(3)
  })

  test("comments without durable saves receive no retry grant", async () => {
    const { api, publisher } = setup()
    const p = proposal()
    api.rest.issues.createComment.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(publisher.propose(p)).rejects.toBeInstanceOf(GitHubDeferred)
    expect(p.commentRetryAt).toBeUndefined()
    vi.setSystemTime(now + 1000)
    await expect(publisher.propose(p)).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    expect(api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })
})

describe("publication read faults and delayed visibility", () => {
  test.each(["proposal", "labels", "blob", "branch", "PR"])(
    "%s writes retain Retry-After without immediate reconciliation",
    async (phase) => {
      const { api, publisher } = setup()
      const limit = apiError(429, { "retry-after": "3600" })
      let action: () => Promise<unknown>
      if (phase === "proposal") {
        api.rest.issues.createComment.mockRejectedValueOnce(limit)
        action = () => publisher.propose(proposal())
      } else if (phase === "labels") {
        api.rest.issues.addLabels.mockRejectedValueOnce(limit)
        action = () => publisher.labels(12, ["bot:failed"], [])
      } else if (phase === "blob") {
        api.rest.git.createBlob.mockRejectedValueOnce(limit)
        action = () => publisher.publish(job(), proposal(), () => {})
      } else if (phase === "branch") {
        api.rest.git.createRef.mockRejectedValueOnce(limit)
        action = () => publisher.publish(job(), proposal(), () => {})
      } else {
        api.rest.pulls.create.mockRejectedValueOnce(limit)
        action = () => publisher.publish(job(), proposal(), () => {})
      }
      await expect(action()).rejects.toMatchObject({
        code: "github_write_rate_limit",
        retryAt: now + 3_600_000,
      })
      if (phase === "proposal") expect(api.rest.issues.listComments).toHaveBeenCalledTimes(1)
      if (phase === "branch")
        expect(api.rest.git.getRef.mock.calls.at(-1)?.[0].ref).toBe("heads/main")
      if (phase === "PR") expect(api.rest.pulls.list).toHaveBeenCalledTimes(2)
    },
  )

  test("unknown PR writes preserve a subsequent reconciliation read cooldown", async () => {
    const { api, publisher } = setup()
    api.fail("pulls.create", "after")
    api.rest.pulls.list.mockResolvedValueOnce(response([]))
    api.rest.pulls.list.mockResolvedValueOnce(response([]))
    api.rest.pulls.list.mockRejectedValueOnce(apiError(429, { "retry-after": "3600" }))
    await expect(publisher.publish(job(), proposal(), () => {})).rejects.toMatchObject({
      code: "github_rate_limit",
      retryAt: now + 3_600_000,
    })
    expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
    expect(api.prs).toHaveLength(1)
    expect(api.rest.issues.addLabels).not.toHaveBeenCalled()
  })

  test("checks durable cancellation again immediately before branch creation", async () => {
    const { api, publisher } = setup()
    let revoked = false
    api.rest.git.getRef.mockImplementationOnce(async () => {
      revoked = true
      throw apiError(404)
    })
    await expect(
      publisher.publish(job(), proposal(), () => {
        if (revoked) throw new Error("job_cancelled")
      }),
    ).rejects.toThrow("job_cancelled")
    expect(api.rest.git.createRef).not.toHaveBeenCalled()
    expect(api.rest.pulls.create).not.toHaveBeenCalled()
  })

  test("checks the frozen artifact digest again at the publication boundary", async () => {
    const { api, publisher } = setup()
    const current = job()
    if (!current.artifact) throw new Error("fixture missing artifact")
    current.artifact.files[0].content = Buffer.from("Changed after validation").toString("base64")
    await expect(publisher.publish(current, proposal(), () => {})).rejects.toMatchObject({
      code: "publication_invalid_artifact",
    })
    expect(api.rest.git.createBlob).not.toHaveBeenCalled()
  })

  test.each([
    "users.getById",
    "git.getCommit",
    "git.getTree",
    "git.getBlob",
    "git.getRef",
    "pulls.list",
  ])("bounds transient reads at %s and cannot publish with incomplete evidence", async (method) => {
    const { api, publisher } = setup()
    api.fail(method, "before", 4)
    await expect(publisher.publish(job(), proposal(), () => {})).rejects.toBeInstanceOf(
      GitHubDeferred,
    )
    expect(api.trace.filter((call) => call === method)).toHaveLength(4)
    expect(api.rest.git.createRef).not.toHaveBeenCalled()
    expect(api.rest.pulls.create).not.toHaveBeenCalled()
  })

  test("reconciles a PR on a future recovery after an ambiguous response and delayed visibility", async () => {
    const { api, publisher } = setup()
    const p = proposal()
    let durable = job(p)
    const save = (saved: Job) => {
      durable = clone(saved)
    }
    api.rest.pulls.list
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]))
    api.fail("pulls.create")
    await expect(publisher.publish(durable, p, save)).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    expect(api.prs).toHaveLength(1)
    await new Publisher(api.client(), repository, bot.id).publish(durable, p, save)
    expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
  })

  test("reconciles an initially invisible accepted comment on recovery without repeating POST", async () => {
    const { api, publisher } = setup()
    const p = proposal()
    const original = clone(api.comments)
    api.rest.issues.listComments
      .mockResolvedValueOnce(response(original))
      .mockResolvedValueOnce(response(original))
    api.fail("issues.createComment")
    await expect(publisher.propose(p)).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    await new Publisher(api.client(), repository, bot.id).propose(p)
    expect(api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("an unknown branch response blocks until a complete ref read is available", async () => {
    const { api, publisher } = setup()
    const p = proposal()
    let durable = job(p)
    const save = (saved: Job) => {
      durable = clone(saved)
    }
    api.fail("git.createRef", "before")
    await expect(publisher.publish(durable, p, save)).rejects.toMatchObject({
      code: "github_branch_outcome_unknown",
    })
    expect(api.rest.pulls.create).not.toHaveBeenCalled()
    api.refs.set(branchFor(12), durable.publication?.commitSha ?? "")
    await new Publisher(api.client(), repository, bot.id).publish(durable, p, save)
    expect(api.rest.git.createRef).toHaveBeenCalledTimes(1)
    expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
  })
})

describe("trusted draft publication and recovery", () => {
  test.each(["before branch", "before PR"])(
    "base movement %s prevents draft creation",
    async (phase) => {
      const { api, publisher } = setup()
      if (phase === "before branch") {
        const execute = api.rest.git.createCommit.getMockImplementation()
        if (!execute) throw new Error("fixture_mutation_missing")
        api.rest.git.createCommit.mockImplementationOnce(async (params) => {
          const response = await execute(params)
          api.refs.set("main", "b".repeat(40))
          return response
        })
      } else {
        const execute = api.rest.git.createRef.getMockImplementation()
        if (!execute) throw new Error("fixture_mutation_missing")
        api.rest.git.createRef.mockImplementationOnce(async (params) => {
          const response = await execute(params)
          api.refs.set("main", "b".repeat(40))
          return response
        })
      }
      await expect(publisher.publish(job(), proposal(), () => {})).rejects.toMatchObject({
        code: "publication_base_changed",
      })
      expect(api.rest.pulls.create).not.toHaveBeenCalled()
      if (phase === "before branch") expect(api.rest.git.createRef).not.toHaveBeenCalled()
    },
  )

  test("canonical GitHub PR URLs accept the configured repository's case-insensitive identity", async () => {
    const { publisher } = setup()
    const p = proposal()
    p.ref.owner = p.ref.owner.toUpperCase()
    p.ref.name = p.ref.name.toUpperCase()
    expect((await publisher.publish(job(p), p, () => {})).state).toBe("pr_ready")
  })

  test("a PR response for a different open base is not accepted or created twice", async () => {
    const { api, publisher } = setup()
    const create = api.rest.pulls.create.getMockImplementation()
    if (!create) throw new Error("fixture_pr_creation_missing")
    api.rest.pulls.create.mockImplementationOnce(async (params) => {
      const response = await create(params)
      response.data.base.sha = "b".repeat(40)
      api.prs[0].base.sha = "b".repeat(40)
      return response
    })
    await expect(publisher.publish(job(), proposal(), () => {})).rejects.toMatchObject({
      code: "publication_pr_conflict",
    })
    expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
  })

  test("persists intents and deterministic metadata before mutations and creates one draft", async () => {
    const { api, publisher } = setup()
    const p = proposal()
    let durable = job(p)
    const saves: Job[] = []
    const result = await publisher.publish(durable, p, (saved) => {
      durable = clone(saved)
      saves.push(durable)
      api.trace.push(
        `save:${saved.publication?.prNumber ? "confirmed" : saved.publication?.prIntent ? "pr-intent" : saved.publication?.commitSha ? "commit" : "intent"}`,
      )
    })
    expect(result.state).toBe("pr_ready")
    expect(
      [
        ...new Set(
          saves.map((saved) =>
            JSON.stringify([
              !!saved.publication?.commitSha,
              !!saved.publication?.prIntent,
              !!saved.publication?.prNumber,
            ]),
          ),
        ),
      ].map((phase) => JSON.parse(phase)),
    ).toEqual([
      [false, false, false],
      [true, false, false],
      [true, true, false],
      [true, true, true],
    ])
    for (const method of [
      "git.createBlob",
      "git.createTree",
      "git.createCommit",
      "git.createRef",
      "pulls.create",
    ]) {
      expect(api.trace[api.trace.indexOf(method) - 1]).toMatch(/^save:/)
    }
    expect(api.rest.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        parents: [fixture.baseSha],
        author: {
          name: bot.login,
          email: `99+${bot.login}@users.noreply.github.com`,
          date: fixture.now,
        },
        committer: {
          name: bot.login,
          email: `99+${bot.login}@users.noreply.github.com`,
          date: fixture.now,
        },
      }),
    )
    expect(api.rest.pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: true,
        head: branchFor(12),
        base: "main",
        title: "fix: Correct the documented result (#12)",
      }),
    )
    const body = api.prs[0].body
    expect(body).toContain("Fixes https://github.com/octo-org/example/issues/12")
    expect(body).toContain("exit 0; 15 ms; image worker&#64;sha256:abc")
    expect(body).not.toContain("untrusted diagnostics")
    await publisher.publish(durable, p, () => {})
    expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
    expect(api.rest.git.createRef).toHaveBeenCalledTimes(1)
  })

  test.each(["git.createBlob", "git.createTree", "git.createCommit"])(
    "recovers response loss at the content-addressed %s boundary",
    async (stage) => {
      const { api, publisher } = setup()
      const p = proposal()
      let durable = job(p)
      const save = (saved: Job) => {
        durable = clone(saved)
      }
      api.fail(stage)
      await expect(publisher.publish(durable, p, save)).rejects.toThrow()
      await publisher.publish(durable, p, save)
      expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
      if (stage === "git.createCommit") {
        const inputs = api.rest.git.createCommit.mock.calls.map(([params]) => params)
        expect(inputs[0]).toEqual(inputs[1])
        expect(api.commits.size).toBe(1)
      }
    },
  )

  test.each(["git.createRef", "pulls.create"])(
    "reconciles an accepted %s after response loss",
    async (stage) => {
      const { api, publisher } = setup()
      api.fail(stage)
      const p = proposal()
      let durable = job(p)
      await publisher.publish(durable, p, (saved) => {
        durable = clone(saved)
      })
      await new Publisher(api.client(), repository, bot.id).publish(durable, p, () => {})
      expect(api.rest.git.createRef).toHaveBeenCalledTimes(1)
      expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
    },
  )

  test("unknown PR acceptance blocks repeated creation across restart", async () => {
    const { api, publisher } = setup()
    api.fail("pulls.create", "before")
    const p = proposal()
    let durable = job(p)
    const save = (saved: Job) => {
      durable = clone(saved)
    }
    await expect(publisher.publish(durable, p, save)).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    expect(durable.publication?.prIntent).toBe(true)
    await expect(
      new Publisher(api.client(), repository, bot.id).publish(durable, p, save),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
  })

  test.each(["intent", "commit", "pr-intent", "confirmed"])(
    "recovers or stops safely after durable save boundary %s",
    async (crashAt) => {
      const { api, publisher } = setup()
      const p = proposal()
      let durable = job(p)
      await expect(
        publisher.publish(durable, p, (saved) => {
          durable = clone(saved)
          const phase = saved.publication?.prNumber
            ? "confirmed"
            : saved.publication?.prIntent
              ? "pr-intent"
              : saved.publication?.commitSha
                ? "commit"
                : "intent"
          if (phase === crashAt) throw new Error("crash after durable save")
        }),
      ).rejects.toThrow("crash after durable save")
      const recovery = new Publisher(api.client(), repository, bot.id).publish(
        durable,
        p,
        (saved) => {
          durable = clone(saved)
        },
      )
      if (crashAt === "pr-intent")
        await expect(recovery).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
      else await expect(recovery).resolves.toMatchObject({ state: "pr_ready" })
      expect(api.rest.pulls.create.mock.calls.length).toBeLessThanOrEqual(1)
      expect(api.rest.git.createRef.mock.calls.length).toBeLessThanOrEqual(1)
    },
  )

  test.each(["issues.addLabels", "issues.removeLabel"])(
    "label failure at %s does not recreate PRs",
    async (stage) => {
      const { api, publisher } = setup()
      api.fail(stage)
      const p = proposal()
      let durable = job(p)
      const save = (saved: Job) => {
        durable = clone(saved)
      }
      await expect(publisher.publish(durable, p, save)).rejects.toThrow()
      expect(durable.state).toBe("pr_ready")
      await publisher.publish(durable, p, save)
      expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
    },
  )

  test.each([false, true])(
    "closed PRs are terminal, including merged=%s and deleted branches",
    async (merged) => {
      const { api, publisher } = setup()
      const p = proposal()
      let durable = job(p)
      const save = (saved: Job) => {
        durable = clone(saved)
      }
      await publisher.publish(durable, p, save)
      api.prs[0].state = "closed"
      if (merged) api.prs[0].merged_at = fixture.now
      api.refs.delete(branchFor(12))
      await publisher.publish(durable, p, save)
      expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
      expect(api.rest.git.createRef).toHaveBeenCalledTimes(1)
    },
  )

  test("never overwrites a foreign branch or creates a PR for it", async () => {
    const { api, publisher } = setup()
    api.refs.set(branchFor(12), "2".repeat(40))
    await expect(publisher.publish(job(), proposal(), () => {})).rejects.toMatchObject({
      code: "publication_branch_conflict",
    })
    expect(api.rest.git.createRef).not.toHaveBeenCalled()
    expect(api.rest.pulls.create).not.toHaveBeenCalled()
    expect(api.refs.get(branchFor(12))).toBe("2".repeat(40))
  })

  test.each(["author", "marker", "base", "sha", "head", "repository", "duplicate"])(
    "rejects %s PR conflicts and does not create a second PR",
    async (kind) => {
      const { api, publisher } = setup()
      const p = proposal()
      let durable = job(p)
      const save = (saved: Job) => {
        durable = clone(saved)
      }
      await publisher.publish(durable, p, save)
      const pr = api.prs[0]
      if (kind === "author") pr.user = actor
      if (kind === "marker") pr.body = "foreign"
      if (kind === "base") pr.base.ref = "other"
      if (kind === "sha") pr.head.sha = "2".repeat(40)
      if (kind === "head") pr.head.ref = "foreign"
      if (kind === "repository") pr.head.repo.id = 999
      if (kind === "duplicate") api.prs.push({ ...pr, number: 41 })
      await expect(publisher.publish(durable, p, save)).rejects.toMatchObject({
        code: "publication_pr_conflict",
      })
      expect(api.rest.pulls.create).toHaveBeenCalledTimes(1)
    },
  )

  test("incomplete PR reconciliation cannot create or repeat a PR", async () => {
    const { api, publisher } = setup()
    api.prsLink = '<https://api.github.test/?page=2>; rel="next"'
    await expect(publisher.publish(job(), proposal(), () => {})).rejects.toThrow()
    expect(api.rest.pulls.create).not.toHaveBeenCalled()
  })

  test.each([
    "failed-check",
    "missing-check",
    "untrusted-command",
    "bad-image",
    "scope",
    "base64",
    "binary",
    "mode",
    "noop",
    "cancelled",
  ])("blocks %s artifacts before any reference or PR mutation", async (kind) => {
    const { api, publisher } = setup()
    const p = proposal()
    const j = job(p)
    const artifact = j.artifact
    if (!artifact) throw new Error("fixture missing artifact")
    if (kind === "failed-check") artifact.verification[0].exitCode = 1
    if (kind === "missing-check") artifact.verification = []
    if (kind === "untrusted-command") artifact.verification[0].argv = ["agent-selected-command"]
    if (kind === "bad-image") artifact.verification[0].image = "other"
    if (kind === "scope") artifact.files[0].path = "src/unapproved.ts"
    if (kind === "base64") artifact.files[0].content = "invalid!"
    if (kind === "binary") artifact.files[0].content = Buffer.from([0]).toString("base64")
    if (kind === "mode") artifact.files[0].mode = "100755"
    if (kind === "noop")
      artifact.files[0].content = Buffer.from(fixture.baseContent).toString("base64")
    if (kind === "cancelled") j.state = "cancelled"
    if (kind !== "base64") artifact.hash = artifactHash(artifact)
    await expect(publisher.publish(j, p, () => {})).rejects.toThrow()
    expect(api.rest.git.createRef).not.toHaveBeenCalled()
    expect(api.rest.pulls.create).not.toHaveBeenCalled()
  })
})
