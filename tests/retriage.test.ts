import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Publisher } from "../src/github/publisher.js"
import {
  currentRetriage,
  inspectRetriage,
  RETRIAGE_LABEL,
  type RetriageCandidate,
  retriageCandidateKey,
  validateRetriage,
} from "../src/github/retriage.js"
import { GitHub, type GitHubClient, GitHubDeferred } from "../src/github/scanner.js"
import { REVIEW_LABELS } from "../src/triage/review.js"
import type { Actor, Issue, RetriageRequest } from "../src/types.js"

const now = Date.parse("2026-11-03T12:00:00Z")
const createdAt = now - 60_000
const repository = { id: 77, installationId: 88, owner: "example", name: "project" }
const actor: Actor = { id: 42, login: "maintainer", type: "User" }
const bot: Actor = { id: 99, login: "reina[bot]", type: "Bot" }
const iso = (time: number) => new Date(time).toISOString()
const response = <T>(data: T, link?: string) => ({ data: structuredClone(data), headers: { link } })
const apiError = (status = 500, headers: Record<string, string> = {}) =>
  Object.assign(new Error("PRIVATE_REMOTE_DIAGNOSTICS"), { status, response: { headers } })

interface RawEvent {
  id: number
  event: string
  actor: Actor | null
  created_at: string
  label?: { name: string }
}

interface RawComment {
  id: number
  user: Actor
  body: string
  created_at: string
  updated_at: string
}

function setup() {
  const rawIssue: {
    id: number
    number: number
    title: string
    body: string
    state: string
    labels: string[]
    created_at?: string
    pull_request?: object
  } = {
    id: 123,
    number: 12,
    title: "PRIVATE_ISSUE_TITLE",
    body: "PRIVATE_ISSUE_BODY",
    state: "open",
    labels: [RETRIAGE_LABEL, "bot:approved"],
    created_at: iso(now - 86_400_000),
  }
  const events: RawEvent[] = [
    {
      id: 1001,
      event: "labeled",
      actor: { ...actor },
      created_at: iso(createdAt),
      label: { name: RETRIAGE_LABEL },
    },
  ]
  const comments: RawComment[] = []
  const permission = { permission: "write", user: { ...actor } }
  const cleanupState = { intent: false }
  function add(event: string, who = actor, time = now, label = RETRIAGE_LABEL) {
    events.push({
      id: 1001 + events.length,
      event,
      actor: { ...who },
      created_at: iso(time),
      label: { name: label },
    })
    if (event === "labeled") rawIssue.labels = [...new Set([...rawIssue.labels, label])]
    if (event === "unlabeled") rawIssue.labels = rawIssue.labels.filter((item) => item !== label)
  }
  const rest = {
    repos: {
      get: vi.fn(async () =>
        response({ id: repository.id, name: repository.name, owner: { login: repository.owner } }),
      ),
      getCollaboratorPermissionLevel: vi.fn(async () => response(permission)),
    },
    issues: {
      get: vi.fn(async () => response({ ...rawIssue, comments: comments.length })),
      listComments: vi.fn(async () => response(comments)),
      listEvents: vi.fn(async () => response(events)),
      removeLabel: vi.fn(async ({ name }: { name: string }) => {
        expect(name).toBe(RETRIAGE_LABEL)
        expect(cleanupState.intent).toBe(true)
        add("unlabeled", bot)
        return response(rawIssue.labels)
      }),
      addLabels: vi.fn(async () => {
        throw new Error("trigger_must_never_be_added")
      }),
      createLabel: vi.fn(async () => {
        throw new Error("trigger_must_never_be_provisioned")
      }),
    },
  }
  const client = {
    auth: vi.fn(async () => ({
      tokenType: "installation",
      installationId: repository.installationId,
    })),
    rest,
  } as unknown as GitHubClient
  const github = new GitHub(client, repository, bot.id, undefined, bot.login)
  const publisher = new Publisher(client, repository, bot.id)
  const issue: Issue = {
    ref: { ...repository, issueId: rawIssue.id, number: rawIssue.number },
    title: rawIssue.title,
    body: rawIssue.body,
    labels: [...rawIssue.labels],
    comments: [],
    state: "open",
    pullRequest: false,
    createdAt: now - 86_400_000,
  }
  const candidate: RetriageCandidate = { createdAt, candidateKey: "" }
  function rekey() {
    candidate.candidateKey = retriageCandidateKey(
      issue.ref,
      actor,
      candidate.createdAt,
      createHash("sha256")
        .update(JSON.stringify([issue.title, issue.body]))
        .digest("hex"),
    )
  }
  rekey()
  const inspect = (source?: string) => inspectRetriage(github, issue, candidate, actor, source)
  const claimRemoval = vi.fn(() => {
    if (cleanupState.intent) return false
    cleanupState.intent = true
    return true
  })
  const consume = (request: RetriageRequest, current = publisher) =>
    current.consumeRetriage(issue, request, claimRemoval)
  return {
    rawIssue,
    events,
    comments,
    permission,
    rest,
    github,
    publisher,
    client,
    issue,
    candidate,
    inspect,
    consume,
    claimRemoval,
    cleanupState,
    add,
    rekey,
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

describe("authoritative read-only retriage requests", () => {
  test("hashes only stable pinned identity and changes for each bound field", () => {
    const value = setup()
    const contentHash = createHash("sha256")
      .update(JSON.stringify([value.issue.title, value.issue.body]))
      .digest("hex")
    const key = (ref = value.issue.ref, sender = actor, time = createdAt, hash = contentHash) =>
      retriageCandidateKey(ref, sender, time, hash)
    expect(key()).toMatch(/^[a-f\d]{64}$/)
    expect(key()).toBe(value.candidate.candidateKey)
    expect(key({ ...value.issue.ref, owner: "EXAMPLE", name: "PROJECT" })).toBe(key())
    for (const field of ["installationId", "id", "issueId", "number"] as const) {
      expect(key({ ...value.issue.ref, [field]: value.issue.ref[field] + 1 })).not.toBe(key())
    }
    expect(key(value.issue.ref, { ...actor, id: actor.id + 1 })).not.toBe(key())
    expect(key(value.issue.ref, actor, createdAt + 1000)).not.toBe(key())
    expect(key(value.issue.ref, actor, createdAt, "f".repeat(64))).not.toBe(key())
  })

  test.each(["write", "maintain", "admin"])("pins history with %s access", async (permission) => {
    const value = setup()
    value.permission.permission = permission
    const request = await value.inspect()
    expect(request).toEqual({
      source: "retriage:88:77:123:12:1001",
      candidateKey: value.candidate.candidateKey,
      createdAt,
      actor,
    })
    expect(request).not.toHaveProperty("request")
    expect(request).not.toHaveProperty("proposalRevision")
    expect(JSON.stringify(request)).not.toContain("PRIVATE_")
    await expect(validateRetriage(value.github, value.issue, request)).resolves.toBeUndefined()
    expect(value.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith(
      expect.objectContaining({ username: actor.login }),
    )
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
  })

  test("accepts a fresh event at the upper bound, but not at 24 hours", async () => {
    const value = setup()
    value.candidate.createdAt = now
    value.events[0].created_at = iso(now)
    value.rekey()
    await expect(value.inspect()).resolves.toMatchObject({ createdAt: now })
    vi.setSystemTime(now + 86_400_000)
    await expect(value.inspect()).rejects.toMatchObject({ code: "retriage_request_not_current" })
  })

  test.each([
    "missing",
    "present-only",
    "removed",
    "replacement",
    "same-time-add",
    "same-time-remove",
    "timestamp-earlier",
    "timestamp-later",
  ])("rejects %s transition evidence", async (kind) => {
    const value = setup()
    if (kind === "missing") {
      value.rawIssue.labels = []
      value.issue.labels = []
    }
    if (kind === "missing" || kind === "present-only") value.events.length = 0
    if (kind === "removed") value.add("unlabeled")
    if (kind === "replacement") {
      value.add("unlabeled", actor, createdAt + 1000)
      value.add("labeled", actor, createdAt + 2000)
    }
    if (kind === "same-time-add") value.add("labeled", actor, createdAt)
    if (kind === "same-time-remove") value.add("unlabeled", actor, createdAt)
    if (kind === "timestamp-earlier") value.events[0].created_at = iso(createdAt - 1000)
    if (kind === "timestamp-later") value.events[0].created_at = iso(createdAt + 1000)
    await expect(value.inspect()).rejects.toMatchObject({
      code: expect.stringMatching(/^retriage_/),
    })
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
  })

  test.each(["closed", "pr", "skip", "close-reopen", "skip-removed"])(
    "rejects %s lifecycle evidence",
    async (kind) => {
      const value = setup()
      if (kind === "closed") value.rawIssue.state = "closed"
      if (kind === "pr") value.rawIssue.pull_request = {}
      if (kind === "skip") value.rawIssue.labels.push("bot:skip")
      if (kind === "close-reopen") {
        value.add("closed", actor, createdAt + 1000, "")
        value.add("reopened", actor, createdAt + 2000, "")
      }
      if (kind === "skip-removed") {
        value.add("labeled", actor, createdAt + 1000, "bot:skip")
        value.add("unlabeled", actor, createdAt + 2000, "bot:skip")
      }
      await expect(value.inspect()).rejects.toMatchObject({
        code: expect.stringMatching(/^retriage_/),
      })
    },
  )

  test.each(["id", "login", "type", "bot", "unsafe", "negative"])(
    "rejects mismatched or nonhuman actor %s",
    async (kind) => {
      const value = setup()
      const sender = { ...actor }
      if (kind === "id") sender.id++
      if (kind === "login") sender.login = "renamed"
      if (kind === "type") sender.type = "Organization"
      if (kind === "bot") Object.assign(sender, bot)
      if (kind === "unsafe") sender.id = Number.MAX_SAFE_INTEGER + 1
      if (kind === "negative") sender.id = -1
      await expect(
        inspectRetriage(value.github, value.issue, value.candidate, sender),
      ).rejects.toThrow()
    },
  )

  test.each(["id", "login", "type"])("rejects mismatched history actor %s", async (field) => {
    const value = setup()
    const author = { ...actor }
    if (field === "id") author.id++
    if (field === "login") author.login = "renamed"
    if (field === "type") author.type = "Bot"
    value.events[0].actor = author
    await expect(value.inspect()).rejects.toMatchObject({
      code: "retriage_transition_not_current",
    })
    expect(value.rest.repos.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  test.each(["read", "triage", "none", "custom-role"])(
    "rejects live %s permission",
    async (permission) => {
      const value = setup()
      value.permission.permission = permission
      await expect(value.inspect()).rejects.toMatchObject({ code: "retriage_permission_denied" })
    },
  )

  test("rechecks numeric identity and permission on resumption and claim", async () => {
    const value = setup()
    const request = await value.inspect()
    value.permission.user.id++
    await expect(validateRetriage(value.github, value.issue, request)).rejects.toMatchObject({
      code: "retriage_actor_mismatch",
    })
    value.permission.user.id--
    value.permission.permission = "read"
    await expect(value.inspect(request.source)).rejects.toMatchObject({
      code: "retriage_permission_denied",
    })
    await expect(value.consume(request)).rejects.toMatchObject({
      code: "retriage_permission_denied",
    })
    expect(value.claimRemoval).not.toHaveBeenCalled()
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
  })

  test.each(["future", "old", "invalid", "negative", "unsafe"])(
    "rejects %s candidate time",
    async (kind) => {
      const value = setup()
      if (kind === "future") value.candidate.createdAt = now + 1
      if (kind === "old") value.candidate.createdAt = now - 86_400_000
      if (kind === "invalid") value.candidate.createdAt = Number.NaN
      if (kind === "negative") value.candidate.createdAt = -1
      if (kind === "unsafe") value.candidate.createdAt = Number.MAX_SAFE_INTEGER + 1
      await expect(value.inspect()).rejects.toMatchObject({ code: "retriage_request_not_current" })
    },
  )

  test.each(["repository", "installation", "owner", "name", "issue-id", "number", "unsafe-id"])(
    "rejects wrong pinned %s",
    async (kind) => {
      const value = setup()
      if (kind === "repository") value.issue.ref.id++
      if (kind === "installation") value.issue.ref.installationId++
      if (kind === "owner") value.issue.ref.owner = "other"
      if (kind === "name") value.issue.ref.name = "other"
      if (kind === "issue-id") value.issue.ref.issueId++
      if (kind === "number") value.issue.ref.number++
      if (kind === "unsafe-id") value.issue.ref.issueId = Number.MAX_SAFE_INTEGER + 1
      await expect(value.inspect()).rejects.toThrow()
    },
  )

  test.each(["title", "body", "source-hash", "new-creation", "missing-creation"])(
    "rejects changed %s evidence instead of rebinding",
    async (kind) => {
      const value = setup()
      if (kind === "title") value.rawIssue.title += " changed"
      if (kind === "body") value.rawIssue.body += " changed"
      if (kind === "source-hash") value.candidate.candidateKey = "a".repeat(64)
      if (kind === "new-creation") value.rawIssue.created_at = iso(now)
      if (kind === "missing-creation") delete value.rawIssue.created_at
      await expect(value.inspect()).rejects.toMatchObject({
        code: expect.stringMatching(/^retriage_/),
      })
    },
  )

  test("keeps absent creation metadata optional when both reads omit it", async () => {
    const value = setup()
    delete value.rawIssue.created_at
    delete value.issue.createdAt
    await expect(value.inspect()).resolves.toMatchObject({ source: "retriage:88:77:123:12:1001" })
  })

  test.each([
    "new",
    "edited",
    "same-time",
    "future-update",
    "missing-update",
    "changed-during-read",
  ])("rejects %s comment evidence", async (kind) => {
    const value = setup()
    const comment: RawComment = {
      id: 10,
      user: { ...actor },
      body: "PRIVATE_COMMENT_BODY",
      created_at: iso(createdAt - 2000),
      updated_at: iso(createdAt - 2000),
    }
    if (kind === "new" || kind === "same-time") {
      comment.created_at = iso(kind === "new" ? now : createdAt)
      comment.updated_at = comment.created_at
    }
    if (kind === "edited") comment.updated_at = iso(now)
    if (kind === "future-update") comment.updated_at = iso(now + 1000)
    if (kind === "missing-update") comment.updated_at = ""
    value.comments.push(comment)
    value.issue.comments.push({ id: comment.id, authorId: actor.id, body: comment.body })
    if (kind === "changed-during-read") {
      value.rest.issues.listComments.mockResolvedValueOnce(response([comment]))
      value.rest.issues.listComments.mockResolvedValueOnce(
        response([{ ...comment, body: "changed" }]),
      )
    }
    await expect(value.inspect()).rejects.toMatchObject({ code: "retriage_issue_changed" })
  })

  test("allows old ordinary evidence and ignores bot-owned publication comments", async () => {
    const value = setup()
    const comment: RawComment = {
      id: 10,
      user: { ...actor },
      body: "Prior evidence",
      created_at: iso(createdAt - 2000),
      updated_at: iso(createdAt - 1000),
    }
    value.comments.push(comment)
    value.issue.comments.push({ id: 10, authorId: actor.id, body: comment.body })
    value.comments.push({
      ...comment,
      id: 11,
      user: bot,
      body: "Read-only summary",
      created_at: iso(now),
      updated_at: iso(now),
    })
    await expect(value.inspect()).resolves.toMatchObject({ createdAt })
  })

  test.each([
    "duplicate",
    "unsafe-id",
    "zero-id",
    "negative-time",
    "future-time",
    "missing-actor",
    "missing-login",
    "unordered",
    "limit",
  ])("fails closed on %s authoritative history", async (kind) => {
    const value = setup()
    if (kind === "duplicate") value.events.push({ ...value.events[0] })
    if (kind === "unsafe-id") value.events[0].id = Number.MAX_SAFE_INTEGER + 1
    if (kind === "zero-id") value.events[0].id = 0
    if (kind === "negative-time") value.events[0].created_at = iso(-1)
    if (kind === "future-time") value.events[0].created_at = iso(now + 1)
    if (kind === "missing-actor") value.events[0].actor = null
    if (kind === "missing-login") value.events[0].actor = { ...actor, login: "" }
    if (kind === "unordered")
      value.events.push({ ...value.events[0], id: 1002, created_at: iso(createdAt - 1) })
    if (kind === "limit")
      value.rest.issues.listEvents.mockResolvedValue(
        response(value.events, '<https://untrusted.invalid/page=999>; rel="next"'),
      )
    await expect(value.inspect()).rejects.toThrow()
    if (kind === "limit") expect(value.rest.issues.listEvents).toHaveBeenCalledTimes(10)
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
  })
})

describe("pinned resumption and removal-only cleanup", () => {
  test("accepts uniquely confirmed bot cleanup in the same second as admission", async () => {
    const value = setup()
    const request = await value.inspect()
    value.rest.issues.removeLabel.mockImplementationOnce(async () => {
      value.add("unlabeled", bot, createdAt)
      return response(value.rawIssue.labels)
    })
    await expect(value.consume(request)).resolves.toBeUndefined()
    await expect(validateRetriage(value.github, value.issue, request)).resolves.toBeUndefined()
    const restarted = new Publisher(value.client, repository, bot.id)
    await expect(value.consume(request, restarted)).resolves.toBeUndefined()
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
    expect(value.claimRemoval).toHaveBeenCalledTimes(1)
  })

  test("consumes only the admitted trigger and proves cleanup after restart", async () => {
    const value = setup()
    const request = await value.inspect()
    await value.consume(request)
    expect(value.claimRemoval).toHaveBeenCalledTimes(1)
    expect(value.cleanupState.intent).toBe(true)
    expect(value.rest.issues.removeLabel).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        owner: repository.owner,
        repo: repository.name,
        issue_number: 12,
        name: RETRIAGE_LABEL,
        request: { retries: 0 },
      }),
    )
    expect(value.rawIssue.labels).toEqual(["bot:approved"])
    expect(value.rest.issues.addLabels).not.toHaveBeenCalled()
    expect(value.rest.issues.createLabel).not.toHaveBeenCalled()
    await expect(validateRetriage(value.github, value.issue, request)).resolves.toBeUndefined()
    await expect(value.inspect(request.source)).resolves.toEqual(request)
    await expect(currentRetriage(value.github, value.issue, request)).resolves.toMatchObject({
      present: false,
    })
    await value.consume(request, new Publisher(value.client, repository, bot.id))
    expect(value.claimRemoval).toHaveBeenCalledTimes(1)
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
    // Bot removal is valid only for an existing admission, not a fresh candidate.
    await expect(value.inspect()).rejects.toThrow()
  })

  test.each([
    "human",
    "foreign-bot",
    "wrong-bot-type",
    "same-time-human-replacement",
    "absent-without-event",
    "cleanup-but-present",
  ])("does not mistake %s cleanup for consumption", async (kind) => {
    const value = setup()
    const request = await value.inspect()
    if (kind === "human") value.add("unlabeled")
    if (kind === "foreign-bot") value.add("unlabeled", { ...bot, id: 100 })
    if (kind === "wrong-bot-type") value.add("unlabeled", { ...bot, type: "User" })
    if (kind === "same-time-human-replacement") {
      value.add("unlabeled", bot, createdAt)
      value.add("labeled", actor, createdAt)
    }
    if (kind === "absent-without-event") value.rawIssue.labels = []
    if (kind === "cleanup-but-present") {
      value.add("unlabeled", bot)
      value.rawIssue.labels.push(RETRIAGE_LABEL)
    }
    await expect(validateRetriage(value.github, value.issue, request)).rejects.toThrow()
    await expect(value.consume(request)).rejects.toThrow()
    expect(value.claimRemoval).not.toHaveBeenCalled()
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
  })

  test("never binds an old wakeup or admission to a replacement transition", async () => {
    const value = setup()
    const request = await value.inspect()
    value.add("unlabeled", actor, createdAt + 1000)
    value.add("labeled", actor, createdAt + 2000)
    await expect(value.inspect()).rejects.toThrow()
    await expect(value.inspect(request.source)).rejects.toThrow()
    await expect(validateRetriage(value.github, value.issue, request)).rejects.toThrow()
    await expect(value.consume(request)).rejects.toThrow()
    expect(value.claimRemoval).not.toHaveBeenCalled()
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
    value.candidate.createdAt = createdAt + 2000
    value.rekey()
    const replacement = await value.inspect()
    expect(replacement.source).not.toBe(request.source)
    expect(replacement.candidateKey).not.toBe(request.candidateKey)
    // Even a matching newer candidate cannot replace an admitted history identity.
    await expect(value.inspect(request.source)).rejects.toThrow()
  })

  test.each(["source", "foreign-repository", "foreign-issue", "candidate-key", "time", "actor"])(
    "rejects altered admitted %s",
    async (kind) => {
      const value = setup()
      const request = await value.inspect()
      if (kind === "source") request.source = "retriage:88:77:123:12:1002"
      if (kind === "foreign-repository") request.source = "retriage:88:78:123:12:1001"
      if (kind === "foreign-issue") request.source = "retriage:88:77:124:12:1001"
      if (kind === "candidate-key") request.candidateKey = "f".repeat(64)
      if (kind === "time") request.createdAt++
      if (kind === "actor") request.actor.id++
      await expect(value.consume(request)).rejects.toThrow()
      expect(value.claimRemoval).not.toHaveBeenCalled()
      expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
    },
  )

  test("denies inference when a replacement races with DELETE", async () => {
    const value = setup()
    const request = await value.inspect()
    value.rest.issues.removeLabel.mockImplementationOnce(async () => {
      value.add("unlabeled", actor, createdAt + 1000)
      value.add("labeled", actor, createdAt + 2000)
      value.add("unlabeled", bot)
      return response(value.rawIssue.labels)
    })
    await expect(value.consume(request)).rejects.toMatchObject({
      code: "retriage_transition_replaced",
    })
    await expect(validateRetriage(value.github, value.issue, request)).rejects.toThrow()
    const restarted = new Publisher(value.client, repository, bot.id)
    await expect(value.consume(request, restarted)).rejects.toThrow()
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
  })

  test("does not infer consumption from label absence without a cleanup event", async () => {
    const value = setup()
    const request = await value.inspect()
    value.rest.issues.removeLabel.mockImplementationOnce(async () => {
      value.rawIssue.labels = []
      return response(value.rawIssue.labels)
    })
    await expect(value.consume(request)).rejects.toThrow()
    await expect(validateRetriage(value.github, value.issue, request)).rejects.toThrow()
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
  })

  test("reconciles a lost DELETE response only with authoritative bot cleanup", async () => {
    const value = setup()
    const request = await value.inspect()
    value.rest.issues.removeLabel.mockImplementationOnce(async () => {
      value.add("unlabeled", bot)
      throw apiError()
    })
    await expect(value.consume(request)).resolves.toBeUndefined()
    await expect(value.consume(request)).resolves.toBeUndefined()
    expect(value.claimRemoval).toHaveBeenCalledTimes(1)
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
  })

  test.each([404, 500])("does not blindly repeat an unconfirmed %s DELETE", async (status) => {
    const value = setup()
    const request = await value.inspect()
    value.rest.issues.removeLabel.mockRejectedValueOnce(apiError(status))
    await expect(value.consume(request)).rejects.toMatchObject({
      code: "github_retriage_outcome_unknown",
    })
    const restarted = new Publisher(value.client, repository, bot.id)
    await expect(value.consume(request, restarted)).rejects.toMatchObject({
      code: "publication_retriage_cleanup_uncertain",
    })
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
    value.add("unlabeled", bot)
    await expect(value.consume(request, restarted)).resolves.toBeUndefined()
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
  })

  test.each([403, 429])("rechecks after confirmed %s write backoff", async (status) => {
    const value = setup()
    const request = await value.inspect()
    value.rest.issues.removeLabel.mockRejectedValueOnce(apiError(status, { "retry-after": "1" }))
    await expect(value.consume(request)).rejects.toMatchObject({ retryAt: now + 1000 })
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
    vi.setSystemTime(now + 1000)
    value.add("unlabeled", actor, now)
    value.add("labeled", actor, now + 1000)
    await expect(value.consume(request)).rejects.toThrow()
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
  })

  test("does not refund a claimed cleanup even after confirmed write rejection", async () => {
    const value = setup()
    const request = await value.inspect()
    value.rest.issues.removeLabel.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(value.consume(request)).rejects.toBeInstanceOf(GitHubDeferred)
    vi.setSystemTime(now + 1000)
    const restarted = new Publisher(value.client, repository, bot.id)
    await expect(value.consume(request, restarted)).rejects.toMatchObject({
      code: "publication_retriage_cleanup_uncertain",
    })
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
  })

  test("keeps cleanup unclaimed when a metadata read is rate limited", async () => {
    const value = setup()
    const request = await value.inspect()
    value.rest.issues.listEvents.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(value.consume(request)).rejects.toBeInstanceOf(GitHubDeferred)
    expect(value.claimRemoval).not.toHaveBeenCalled()
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
    vi.setSystemTime(now + 1000)
    await value.consume(request)
    expect(value.claimRemoval).toHaveBeenCalledTimes(1)
    expect(value.rest.issues.removeLabel).toHaveBeenCalledTimes(1)
  })

  test("does not send DELETE when the durable cleanup claim is already spent", async () => {
    const value = setup()
    const request = await value.inspect()
    value.cleanupState.intent = true
    await expect(value.consume(request)).rejects.toMatchObject({
      code: "publication_retriage_cleanup_uncertain",
    })
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
  })

  test("a crash after durable cleanup intent cannot regain DELETE authority", async () => {
    const value = setup()
    const request = await value.inspect()
    value.claimRemoval.mockImplementationOnce(() => {
      value.cleanupState.intent = true
      throw new Error("fixture_crash_after_cleanup_intent")
    })
    await expect(value.consume(request)).rejects.toThrow("fixture_crash_after_cleanup_intent")
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
    const restarted = new Publisher(value.client, repository, bot.id)
    await expect(value.consume(request, restarted)).rejects.toMatchObject({
      code: "publication_retriage_cleanup_uncertain",
    })
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
  })

  test("keeps the trigger outside generic label writes and review projections", async () => {
    const value = setup()
    expect(REVIEW_LABELS).not.toContain(RETRIAGE_LABEL)
    await expect(value.publisher.labels(12, [RETRIAGE_LABEL], [])).rejects.toMatchObject({
      code: "publication_invalid_labels",
    })
    await expect(value.publisher.labels(12, [], [RETRIAGE_LABEL])).rejects.toMatchObject({
      code: "publication_invalid_labels",
    })
    expect(value.rest.issues.removeLabel).not.toHaveBeenCalled()
    expect(value.rest.issues.addLabels).not.toHaveBeenCalled()
    expect(value.rest.issues.createLabel).not.toHaveBeenCalled()
  })
})
