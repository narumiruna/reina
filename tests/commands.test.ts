import { createHash } from "node:crypto"
import { HtmlRenderer, Parser } from "commonmark"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { inspectRequest, type RequestCandidate, validateRequest } from "../src/github/commands.js"
import { GitHub, type GitHubClient, GitHubDeferred } from "../src/github/scanner.js"
import type { Actor, ExecutionRequest, Issue } from "../src/types.js"

const now = Date.parse("2026-11-03T10:03:00Z")
const createdAt = now - 60_000
const repository = { id: 1, owner: "owner", name: "repo", installationId: 2 }
const bot: Actor = { id: 99, login: "custom-reina[bot]", type: "Bot" }
const actor: Actor = { id: 42, login: "maintainer", type: "User" }
const hash = (body: string) => createHash("sha256").update(body).digest("hex")
const iso = (time: number) => new Date(time).toISOString()
const response = <T>(data: T, link?: string) => ({ data: structuredClone(data), headers: { link } })
interface RawComment {
  id: number
  user: Actor
  body: string
  created_at: string
  updated_at: string
}
interface RawEvent {
  id: number
  event: string
  actor: Actor | null
  created_at: string
  label?: { name: string }
  assignee?: Actor | null
}

function setup(body = "@custom-reina fix the typo") {
  const comments: RawComment[] = [
    { id: 10, user: { ...actor }, body, created_at: iso(createdAt), updated_at: iso(createdAt) },
  ]
  const events: RawEvent[] = []
  const rawIssue: {
    id: number
    number: number
    title: string
    body: string
    state: string
    labels: string[]
    assignees?: Actor[]
    pull_request?: object
  } = { id: 123, number: 12, title: "Typo", body: "Correct it", state: "open", labels: [] }
  const permission = { permission: "write", user: { ...actor } }
  const rest = {
    repos: {
      get: vi.fn(async () =>
        response({ id: repository.id, name: repository.name, owner: { login: repository.owner } }),
      ),
      getCollaboratorPermissionLevel: vi.fn(async () => response(permission)),
    },
    issues: {
      get: vi.fn(async () => response({ ...rawIssue, comments: comments.length })),
      listComments: vi.fn(async ({ page }: { page: number }) =>
        response(comments.slice((page - 1) * 100, page * 100)),
      ),
      listEvents: vi.fn(async () => response(events)),
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
  const issue: Issue = {
    ref: { ...repository, issueId: rawIssue.id, number: rawIssue.number },
    title: rawIssue.title,
    body: rawIssue.body,
    labels: [],
    comments: [],
    state: "open",
    pullRequest: false,
  }
  const candidate: Extract<RequestCandidate, { kind: "comment" }> = {
    kind: "comment",
    commentId: comments[0].id,
    bodyHash: hash(body),
    createdAt,
    updatedAt: createdAt,
  }
  function assign() {
    comments.length = 0
    rawIssue.assignees = [{ ...bot }]
    events.push({
      id: 1001,
      event: "assigned",
      actor: { ...actor },
      assignee: { ...bot },
      created_at: iso(createdAt),
    })
    return { kind: "assignment", assigneeId: bot.id, createdAt } as const
  }
  return { github, client, rest, rawIssue, issue, comments, events, permission, candidate, assign }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("trusted line-start mention commands", () => {
  test.each([
    ["@custom-reina", "help"],
    ["@custom-reina[bot]", "help"],
    ["@CUSTOM-REINA[BOT] help", "help"],
    ["  @custom-reina: help!", "help"],
    ["@custom-reina fix", "fix"],
    ["@custom-reina create-pr", "fix"],
    ["@custom-reina Please correct the docs and run tests.", "fix"],
    ["@custom-reina[bot] 帮我修复这个问题", "fix"],
    ["@custom-reina：请修改文档", "fix"],
    ["@custom-reina\nPlease add a regression test.", "fix"],
    ["@custom-reina\n- Update the docs\n- Add tests", "fix"],
    ["<pre>\n@custom-reina hidden\n</pre>\n\n@custom-reina help", "help"],
    ["Previous discussion.\r\n@custom-reina create-pr", "fix"],
    ["> quoted mention\n\n@custom-reina fix", "fix"],
    ["- > Example:\n# Request\n@custom-reina fix", "fix"],
    ["> ```\n> quoted code\n@custom-reina fix", "fix"],
    ["```md\n@another-bot fix\n```\n@custom-reina fix", "fix"],
    ["> ```\n> @custom-reina fix\n\n@custom-reina help", "help"],
    ["@custom-reina help\nThanks!", "help"],
    ["@custom-reina help!\nPlease explain the usage.", "help"],
    ["<!-- hidden -->\n@custom-reina fix", "fix"],
    ["<div><!--\n\nhidden\n<div>-->\n\n@custom-reina fix", "fix"],
    ["<div><!-- hidden -->\n\n@custom-reina fix", "fix"],
    ["<div><!--\n\nhidden <!-- nested -->\n\n@custom-reina fix", "fix"],
    ["<div><!--\n\nhidden <!-- nested -->\n@custom-reina fix", "fix"],
    ["@custom-reina <!-- metadata -->", "help"],
    ["@custom-reina\n`fix`", "help"],
    ["@custom-reina\r\n`fix`", "help"],
    ["@custom-reina\n`multi\nfix\n`", "help"],
    ["@custom-reina\nfix `test`", "fix"],
    ["> <!-- closed -->\n\n@custom-reina fix", "fix"],
    ["`<!--`\n\n@custom-reina fix", "fix"],
    ["~~~\n<!--\n~~~\n@custom-reina fix", "fix"],
    ["- ~~~text\n  @custom-reina hidden\n  ~~~\n\n@custom-reina fix", "fix"],
    ["@custom-reina\n\n- ~~~text\n  fix the example\n  ~~~", "help"],
    ["1. ```md\n   @custom-reina hidden\n   ```\n\n@custom-reina help", "help"],
    ["10. ~~~\n    @custom-reina hidden\n    ~~~\n\n@custom-reina fix", "fix"],
    ["- - ~~~\n    @custom-reina hidden\n    ~~~\n\n@custom-reina fix", "fix"],
    ["-\t~~~\n\t@custom-reina hidden\n\t~~~\n\n@custom-reina fix", "fix"],
    ["- ~~~\n  example\n\nOutside the list.\n\n@custom-reina fix", "fix"],
    ["@custom-reina\n<div><!--\n\nfix\n-->", "help"],
  ])("parses %j as %s", async (body, command) => {
    const { github, issue, candidate, rest } = setup(body)
    const result = await inspectRequest(github, issue, candidate, actor)
    expect(result).toEqual(
      command === "help" ? { command, commentId: 10 } : { command, request: candidate },
    )
    expect(rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledWith(
      expect.objectContaining({ username: actor.login }),
    )
  })

  test.each([
    "@reina fix",
    "@another-bot fix",
    "@custom-reina-evil fix",
    "@custom-reina[bot]evil fix",
    "@custom-reina[other] fix",
    "@custom-reina/other fix",
    "@@custom-reina fix",
    "A discussion about @custom-reina fix",
    "- @custom-reina fix",
    "\\@custom-reina fix",
    "&#x40;custom-reina fix",
    "&commat;custom-reina fix",
    "@custom-reina<!-- -->fix",
    "@custom-reina<!-- --> fix",
    "> @custom-reina fix",
    "> Example request:\n@custom-reina fix the typo",
    "`example\n@custom-reina fix the typo\n`",
    "prefix ``example\n@custom-reina fix the typo\n``",
    "  > @custom-reina fix",
    "    @custom-reina fix",
    "\t@custom-reina fix",
    "`@custom-reina fix`",
    "```\n@custom-reina fix\n```",
    "~~~~md\n@custom-reina fix\n~~~\n@custom-reina fix",
    "```\n@custom-reina fix\n~~~\n@custom-reina fix",
    "<!-- @custom-reina fix -->",
    "<!--\n@custom-reina fix\n-->",
    "<!--\n-->@custom-reina fix",
    "<!-- open\n@custom-reina fix",
    "<div><!--\n\n@custom-reina fix\n-->",
    "<div><!--\r\n\r\n@custom-reina fix\r\n-->",
    "<div><!--\n\n-->@custom-reina fix",
    "<div><!-- @custom-reina fix -->",
    "<div><!--\n\nhidden\n-->\n@custom-reina fix",
    "> <!--\n>\n@custom-reina fix\n-->",
    "<div><!--\n\n![<!-- nested -->](x)\n\n@custom-reina fix",
    "<!-- ``` -->\n> @custom-reina fix",
    "- ~~~text\n  @custom-reina fix the typo\n  ~~~",
    "+ ~~~text\n  @custom-reina fix the typo\n  ~~~",
    "* ```md\n  @custom-reina fix the typo\n  ```",
    "1. ~~~text\n   @custom-reina fix the typo\n   ~~~",
    "1) ~~~text\n   @custom-reina fix the typo\n   ~~~",
    "10. ~~~text\n    @custom-reina fix the typo\n    ~~~",
    "- - ~~~\n    @custom-reina fix the typo\n    ~~~",
    "  - ~~~text\n    @custom-reina fix the typo\n    ~~~",
    "-\t~~~text\n\t@custom-reina fix the typo\n\t~~~",
    "- ~~~\n       ~~~\n  @custom-reina fix",
    "- Example:\n    ~~~text\n  @custom-reina fix the typo\n    ~~~",
    "- Example:\n  ~~~text\n  example\n~~~\n@custom-reina fix the typo",
    "~~~\n~~~\u00a0\n@custom-reina fix",
    "<pre>\n@custom-reina fix\n</pre>",
    "- ~~~text\r\n  @custom-reina fix\r\n  ~~~",
    "- > Example:\n  @custom-reina fix",
    "- ~~~\n  example\n\nOutside the list.\n\n  ~~~\n@custom-reina fix\n  ~~~",
  ])("ignores non-command evidence: %j", async (body) => {
    const { github, issue, candidate, rest } = setup(body)
    await expect(inspectRequest(github, issue, candidate, actor)).resolves.toBeUndefined()
    expect(rest.repos.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  test.each([
    "<div><!--\n\n@custom-reina fix\n-->",
    "<div><!--\n\nhidden\n-->\n@custom-reina fix",
    "> <!--\n>\n@custom-reina fix\n-->",
    "<div><!--\n\n~~~\n-->\n~~~\n\n@custom-reina fix",
  ])("never authorizes a command hidden by emitted HTML comments: %j", async (body) => {
    const rendered = new HtmlRenderer().render(new Parser().parse(body))
    expect(rendered.replace(/<!--[\s\S]*?(?:-->|$)/g, "")).not.toContain("@custom-reina fix")
    const { github, issue, candidate, rest } = setup(body)
    await expect(inspectRequest(github, issue, candidate, actor)).resolves.toBeUndefined()
    expect(rest.repos.getCollaboratorPermissionLevel).not.toHaveBeenCalled()
  })

  test("hidden instructions after a bare mention grant help only", async () => {
    const { github, issue, candidate } = setup(
      "@custom-reina\n> fix\n```\nfix\n```\n<!-- fix -->\n`fix`\n- ~~~\n  fix\n  ~~~",
    )
    await expect(inspectRequest(github, issue, candidate, actor)).resolves.toEqual({
      command: "help",
      commentId: 10,
    })
  })

  test("does not infer a bot name when trusted metadata is absent", async () => {
    const { client, issue, candidate } = setup()
    const github = new GitHub(client, repository, bot.id)
    await expect(inspectRequest(github, issue, candidate, actor)).resolves.toBeUndefined()
  })
})

describe("live human comment evidence", () => {
  test.each(["write", "maintain", "admin"])(
    "returns live %s permission on revalidation",
    async (permission) => {
      const value = setup()
      value.permission.permission = permission
      const result = await inspectRequest(value.github, value.issue, value.candidate, actor)
      expect(result).toEqual({ command: "fix", request: value.candidate })
      await expect(
        validateRequest(value.github, value.issue, value.candidate, actor),
      ).resolves.toBe(permission)
      expect(value.rest.issues.listEvents).toHaveBeenCalledTimes(2)
    },
  )

  test.each(["help", "fix", "assignment"])(
    "checks permission before returning %s",
    async (kind) => {
      const value = setup(`@custom-reina ${kind}`)
      const candidate = kind === "assignment" ? value.assign() : value.candidate
      value.permission.permission = "read"
      await expect(
        inspectRequest(value.github, value.issue, candidate, actor),
      ).rejects.toMatchObject({ code: "approval_permission_denied" })
    },
  )

  test.each(["triage", "none", "custom-role"])("rejects %s permission", async (permission) => {
    const value = setup()
    value.permission.permission = permission
    await expect(
      validateRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toMatchObject({ code: "approval_permission_denied" })
  })

  test.each(["id", "login", "type", "self"])(
    "rejects forged or nonhuman actor: %s",
    async (kind) => {
      const value = setup()
      const sender = { ...actor }
      if (kind === "id") sender.id++
      if (kind === "login") sender.login = "other"
      if (kind === "type") sender.type = "Bot"
      if (kind === "self") sender.id = bot.id
      await expect(
        inspectRequest(value.github, value.issue, value.candidate, sender),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^approval_/) })
    },
  )

  test("binds permission to numeric identity, not a recycled login", async () => {
    const value = setup()
    value.permission.user.id++
    await expect(
      validateRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toMatchObject({ code: "approval_actor_mismatch" })
  })

  test.each([
    "body",
    "hash",
    "created",
    "updated",
    "id",
    "author-id",
    "author-login",
    "author-type",
    "deleted",
    "pre-edited",
  ])("rejects changed comment evidence: %s", async (kind) => {
    const value = setup()
    const comment = value.comments[0]
    if (kind === "body") comment.body += " changed"
    if (kind === "hash") value.candidate.bodyHash = "a".repeat(64)
    if (kind === "created") comment.created_at = iso(createdAt - 1000)
    if (kind === "updated") comment.updated_at = iso(createdAt + 1000)
    if (kind === "id") value.candidate.commentId++
    if (kind === "author-id") comment.user.id++
    if (kind === "author-login") comment.user.login = "other"
    if (kind === "author-type") comment.user.type = "Bot"
    if (kind === "deleted") value.comments.length = 0
    if (kind === "pre-edited") {
      comment.updated_at = iso(createdAt + 1000)
      value.candidate.updatedAt = createdAt + 1000
    }
    await expect(
      inspectRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toMatchObject({ code: "approval_comment_changed" })
    await expect(
      validateRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toMatchObject({ code: "approval_comment_changed" })
  })

  test("never replays a request on another issue with matching comment text", async () => {
    const value = setup()
    value.rawIssue.id++
    await expect(
      validateRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toMatchObject({ code: "approval_repository_mismatch" })
  })

  test("revalidation rejects edits, deletion, and permission loss after inspection", async () => {
    const value = setup()
    const result = await inspectRequest(value.github, value.issue, value.candidate, actor)
    expect(result?.command).toBe("fix")
    value.comments[0].updated_at = iso(now)
    await expect(
      validateRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toMatchObject({ code: "approval_comment_changed" })
    value.comments[0].updated_at = iso(createdAt)
    value.permission.permission = "read"
    await expect(
      validateRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toMatchObject({ code: "approval_permission_denied" })
    value.permission.permission = "write"
    value.comments.length = 0
    await expect(
      validateRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toMatchObject({ code: "approval_comment_changed" })
  })

  test("help is not execution authority", async () => {
    const value = setup("@custom-reina help")
    await expect(
      validateRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toMatchObject({ code: "approval_request_not_current" })
  })
})

describe("bot assignment evidence", () => {
  test("captures the GitHub history event ID, independent of assignee login", async () => {
    const value = setup()
    const candidate = value.assign()
    value.events[0].assignee = { ...bot, login: "old-name[bot]" }
    value.rawIssue.assignees = [{ ...bot, login: "new-name[bot]" }]
    const request: ExecutionRequest = { ...candidate, eventId: "1001" }
    await expect(inspectRequest(value.github, value.issue, candidate, actor)).resolves.toEqual({
      command: "fix",
      request,
    })
    await expect(validateRequest(value.github, value.issue, request, actor)).resolves.toBe("write")
  })

  test.each([
    "wrong-bot",
    "wrong-actor",
    "wrong-login",
    "bot-actor",
    "time",
    "missing",
    "unassigned",
    "reassigned",
    "tie",
  ])("rejects stale or forged assignment: %s", async (kind) => {
    const value = setup()
    const candidate: RequestCandidate = { ...value.assign() }
    const event = value.events[0]
    if (kind === "wrong-bot") candidate.assigneeId++
    if (kind === "wrong-actor") event.actor = { ...actor, id: actor.id + 1 }
    if (kind === "wrong-login") event.actor = { ...actor, login: "other" }
    if (kind === "bot-actor") event.actor = { ...bot }
    if (kind === "time") candidate.createdAt--
    if (kind === "missing") delete value.rawIssue.assignees
    if (kind === "unassigned") {
      value.events.push({ ...event, id: 1002, event: "unassigned", created_at: iso(now) })
      value.rawIssue.assignees = []
    }
    if (kind === "reassigned") {
      value.events.push({
        ...event,
        id: 1002,
        event: "unassigned",
        created_at: iso(createdAt + 1000),
      })
      value.events.push({ ...event, id: 1003, created_at: iso(now) })
    }
    if (kind === "tie") value.events.push({ ...event, id: 1002 })
    await expect(inspectRequest(value.github, value.issue, candidate, actor)).rejects.toMatchObject(
      { code: "approval_assignment_not_current" },
    )
  })

  test("binds replay identity to the exact event ID", async () => {
    const value = setup()
    const request: ExecutionRequest = { ...value.assign(), eventId: "other" }
    await expect(validateRequest(value.github, value.issue, request, actor)).rejects.toMatchObject({
      code: "approval_event_replaced",
    })
  })

  test("unassigning another user does not revoke the bot assignment", async () => {
    const value = setup()
    const candidate = value.assign()
    value.events.push({
      id: 1002,
      event: "unassigned",
      actor,
      assignee: actor,
      created_at: iso(now),
    })
    await expect(
      inspectRequest(value.github, value.issue, candidate, actor),
    ).resolves.toMatchObject({ command: "fix" })
  })
})

describe("request revocation and bounded live reads", () => {
  test.each(["comment", "assignment"])("rejects future %s request timestamps", async (kind) => {
    const value = setup()
    const candidate =
      kind === "assignment"
        ? { ...value.assign(), createdAt: now + 1000 }
        : { ...value.candidate, createdAt: now + 1000, updatedAt: now + 1000 }
    await expect(inspectRequest(value.github, value.issue, candidate, actor)).rejects.toMatchObject(
      { code: "approval_request_not_current" },
    )
  })

  test.each(["comment", "assignment"])("expires %s requests after 24 hours", async (kind) => {
    const value = setup()
    const candidate = kind === "assignment" ? value.assign() : value.candidate
    const result = await inspectRequest(value.github, value.issue, candidate, actor)
    if (result?.command !== "fix") throw new Error("missing_request")
    vi.setSystemTime(createdAt + 86_400_000)
    await expect(inspectRequest(value.github, value.issue, candidate, actor)).rejects.toMatchObject(
      {
        code: "approval_request_not_current",
      },
    )
    await expect(
      validateRequest(value.github, value.issue, result.request, actor),
    ).rejects.toMatchObject({
      code: "approval_request_not_current",
    })
  })

  test.each(["title", "body"] as const)(
    "rejects live issue %s drift during validation",
    async (field) => {
      const value = setup()
      const result = await inspectRequest(value.github, value.issue, value.candidate, actor)
      if (result?.command !== "fix") throw new Error("missing_request")
      value.rawIssue[field] = "Changed after the first read"
      await expect(
        validateRequest(value.github, value.issue, result.request, actor),
      ).rejects.toMatchObject({
        code: "approval_issue_changed",
      })
    },
  )

  test.each(["closed", "pr", "skip", "lifecycle", "skip-added-removed", "future-event"])(
    "rejects live ineligibility or revocation: %s",
    async (kind) => {
      const value = setup()
      if (kind === "closed") value.rawIssue.state = "closed"
      if (kind === "pr") value.rawIssue.pull_request = {}
      if (kind === "skip") value.rawIssue.labels = ["bot:skip"]
      if (kind === "lifecycle") {
        value.events.push({ id: 1001, event: "closed", actor, created_at: iso(createdAt + 1000) })
        value.events.push({ id: 1002, event: "reopened", actor, created_at: iso(now) })
      }
      if (kind === "skip-added-removed") {
        value.events.push({
          id: 1001,
          event: "labeled",
          label: { name: "bot:skip" },
          actor,
          created_at: iso(createdAt + 1000),
        })
        value.events.push({
          id: 1002,
          event: "unlabeled",
          label: { name: "bot:skip" },
          actor,
          created_at: iso(now),
        })
      }
      if (kind === "future-event")
        value.events.push({
          id: 1001,
          event: "assigned",
          actor,
          assignee: bot,
          created_at: iso(now + 1000),
        })
      await expect(
        inspectRequest(value.github, value.issue, value.candidate, actor),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^approval_/) })
      await expect(
        validateRequest(value.github, value.issue, value.candidate, actor),
      ).rejects.toMatchObject({ code: expect.stringMatching(/^approval_/) })
    },
  )

  test.each(["comment", "assignment"])(
    "later human comments or non-Reina edits revoke %s requests",
    async (kind) => {
      const value = setup()
      const candidate = kind === "assignment" ? value.assign() : value.candidate
      const source: RawComment = {
        id: 11,
        user: actor,
        body: "The plan changed",
        created_at: iso(now),
        updated_at: iso(now),
      }
      value.comments.push(source)
      await expect(
        inspectRequest(value.github, value.issue, candidate, actor),
      ).rejects.toMatchObject({ code: "approval_issue_changed" })
      source.user = { id: 77, login: "foreign[bot]", type: "Bot" }
      await expect(
        inspectRequest(value.github, value.issue, candidate, actor),
      ).rejects.toMatchObject({ code: "approval_issue_changed" })
      source.created_at = iso(createdAt - 1000)
      await expect(
        inspectRequest(value.github, value.issue, candidate, actor),
      ).rejects.toMatchObject({ code: "approval_issue_changed" })
      source.updated_at = source.created_at
      await expect(
        inspectRequest(value.github, value.issue, candidate, actor),
      ).resolves.toMatchObject({ command: "fix" })
      source.user = bot
      source.created_at = source.updated_at = iso(now)
      await expect(
        inspectRequest(value.github, value.issue, candidate, actor),
      ).resolves.toMatchObject({ command: "fix" })
    },
  )

  test.each(["comment", "assignment"])(
    "rejects a prior comment edited in the same second as the %s request",
    async (kind) => {
      const value = setup()
      const candidate = kind === "assignment" ? value.assign() : value.candidate
      const request: ExecutionRequest =
        candidate.kind === "assignment" ? { ...candidate, eventId: "1001" } : candidate
      const prior: RawComment = {
        id: 9,
        user: actor,
        body: "Updated context",
        created_at: iso(createdAt - 2000),
        updated_at: iso(createdAt),
      }
      value.comments.unshift(prior)
      await expect(
        inspectRequest(value.github, value.issue, candidate, actor),
      ).rejects.toMatchObject({ code: "approval_issue_changed" })
      await expect(
        validateRequest(value.github, value.issue, request, actor),
      ).rejects.toMatchObject({ code: "approval_issue_changed" })

      prior.updated_at = iso(createdAt - 1000)
      await expect(
        inspectRequest(value.github, value.issue, candidate, actor),
      ).resolves.toMatchObject({ command: "fix" })
      await expect(validateRequest(value.github, value.issue, request, actor)).resolves.toBe(
        "write",
      )
    },
  )

  test("fails closed on incomplete history without live writes", async () => {
    const value = setup()
    value.rest.issues.listEvents.mockResolvedValue(
      response(
        [
          {
            id: 1001,
            event: "labeled",
            actor,
            label: { name: "irrelevant" },
            created_at: iso(createdAt),
          },
        ],
        '<https://untrusted.invalid>; rel="next"',
      ),
    )
    await expect(
      inspectRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toThrow()
    expect(Object.keys(value.rest.issues)).toEqual(["get", "listComments", "listEvents"])
  })

  test("retains rate-limit deferrals", async () => {
    const value = setup()
    value.rest.issues.listEvents.mockRejectedValueOnce(
      new GitHubDeferred("github_rate_limit", now + 1000),
    )
    await expect(
      inspectRequest(value.github, value.issue, value.candidate, actor),
    ).rejects.toMatchObject({ code: "github_rate_limit", retryAt: now + 1000 })
  })
})

describe("scanner assignment metadata", () => {
  test("preserves the difference between missing assignees and an empty list", async () => {
    const value = setup()
    expect(await value.github.issue(12)).not.toHaveProperty("assignees")
    value.rawIssue.assignees = []
    expect(await value.github.issue(12)).toHaveProperty("assignees", [])
    value.rawIssue.assignees = [bot]
    expect(await value.github.issue(12)).toHaveProperty("assignees", [bot])
  })

  test("includes strict assignment/unassignment events in history order", async () => {
    const value = setup()
    value.assign()
    value.events.push({ ...value.events[0], id: 1002, event: "unassigned", created_at: iso(now) })
    expect(await value.github.history(12)).toEqual([
      { id: "1001", event: "assigned", label: "", actor, assignee: bot, createdAt },
      { id: "1002", event: "unassigned", label: "", actor, assignee: bot, createdAt: now },
    ])
  })

  test.each(["assignee", "assignee-id", "actor", "time", "ordering", "unsafe-event-id"])(
    "rejects malformed assignment history: %s",
    async (kind) => {
      const value = setup()
      value.assign()
      const event = value.events[0]
      if (kind === "assignee") delete event.assignee
      if (kind === "assignee-id") event.assignee = { ...bot, id: 0 }
      if (kind === "actor") event.actor = null
      if (kind === "time") event.created_at = "not a timestamp"
      if (kind === "ordering")
        value.events.push({ ...event, id: 1002, created_at: iso(createdAt - 1000) })
      if (kind === "unsafe-event-id") event.id = Number.MAX_SAFE_INTEGER + 1
      await expect(value.github.history(12)).rejects.toThrow()
    },
  )
})
