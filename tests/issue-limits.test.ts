import { describe, expect, test, vi } from "vitest"
import {
  GitHub,
  type GitHubClient,
  GitHubDeferred,
  GitHubIssueDeferred,
} from "../src/github/scanner.js"
import { isOwnedTriageSummary, triageMarker } from "../src/github/triage-summary.js"

const contextBytes = 128 * 1024
const summaryBytes = 64 * 1024
const repository = { owner: "example", name: "project", id: 456, installationId: 789 }
const ref = { id: repository.id, issueId: 1012 }
const next = '<https://untrusted.example/other?page=999>; rel="next"'
type Comment = { id: number; body: string; user?: { id?: number | bigint; type?: string } }

function summary(bytes = 100): Comment {
  const prefix = `${triageMarker(ref)}\n`
  return {
    id: 1001,
    body: prefix + "x".repeat(bytes - prefix.length),
    user: { id: 99, type: "Bot" },
  }
}

function fixture() {
  const issue = {
    id: ref.issueId,
    number: 12,
    title: "x",
    body: "",
    labels: [],
    state: "open",
    comments: 0,
  }
  const comments: Comment[] = []
  const links = new Map<number, string>()
  const api = {
    auth: vi.fn(async () => ({ tokenType: "installation", installationId: 789 })),
    rest: {
      repos: {
        get: vi.fn(async () => ({
          data: { id: 456, name: "project", owner: { login: "example" } },
        })),
      },
      issues: {
        get: vi.fn(async () => ({ data: { ...issue } })),
        listComments: vi.fn(async ({ page }: { page: number }) => ({
          data: comments.slice((page - 1) * 100, page * 100),
          headers: { link: links.get(page) ?? (comments.length > page * 100 ? next : undefined) },
        })),
      },
    },
  }
  return {
    issue,
    comments,
    api,
    links,
    github: new GitHub(api as unknown as GitHubClient, repository, 99),
    add(...items: Comment[]) {
      comments.push(...items)
      issue.comments = comments.length
    },
  }
}

function ordinary(count: number): Comment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    body: "x",
    user: { id: 50, type: "User" },
  }))
}

async function localFailure(read: Promise<unknown>, code: string) {
  const error = await read.catch((error: unknown) => error)
  expect(error).toBeInstanceOf(GitHubIssueDeferred)
  expect(error).not.toBeInstanceOf(GitHubDeferred)
  expect(error).toMatchObject({ code })
}

describe("owned triage summary identity", () => {
  test("uses the exact repository and issue IDs", () => {
    expect(triageMarker(ref)).toBe("<!-- reina:triage:456:1012 -->")
    expect(isOwnedTriageSummary(summary(), ref, 99)).toBe(true)
  })

  test.each([
    "foreign author",
    "bigint author",
    "wrong type",
    "missing user",
    "wrong repository",
    "wrong issue",
    "embedded marker",
    "missing newline",
    "CRLF",
    "duplicate prefix",
    "proposal marker",
    "job marker",
    "oversized",
  ])("does not exempt %s", (kind) => {
    const comment = invalidSummary(kind)
    expect(isOwnedTriageSummary(comment, ref, 99)).toBe(false)
  })

  test("uses UTF-8 bytes, not string length", () => {
    const comment = summary(summaryBytes)
    expect(isOwnedTriageSummary(comment, ref, 99)).toBe(true)
    comment.body = `${comment.body.slice(0, -1)}é`
    expect(comment.body.length).toBe(summaryBytes)
    expect(isOwnedTriageSummary(comment, ref, 99)).toBe(false)
  })
})

function invalidSummary(kind: string): Comment {
  const comment = summary()
  if (kind === "foreign author") comment.user = { id: 98, type: "Bot" }
  if (kind === "bigint author") comment.user = { id: 99n, type: "Bot" }
  if (kind === "wrong type") comment.user = { id: 99, type: "User" }
  if (kind === "missing user") delete comment.user
  if (kind === "wrong repository") comment.body = `${triageMarker({ ...ref, id: 457 })}\nx`
  if (kind === "wrong issue") comment.body = `${triageMarker({ ...ref, issueId: 1013 })}\nx`
  if (kind === "embedded marker") comment.body = `untrusted\n${comment.body}`
  if (kind === "missing newline") comment.body = triageMarker(ref)
  if (kind === "CRLF") comment.body = `${triageMarker(ref)}\r\nx`
  if (kind === "duplicate prefix") comment.body += "<!-- reina:triage:malformed"
  if (kind === "proposal marker") comment.body += "<!-- reina:proposal:old -->"
  if (kind === "job marker") comment.body += "<!-- reina:job:old -->"
  if (kind === "oversized") comment.body = summary(summaryBytes + 1).body
  return comment
}

describe.each(["issue", "comments"] as const)("bounded %s evidence", (method) => {
  test("accepts 100 ordinary comments and the owned summary on page 2", async () => {
    const value = fixture()
    value.add(...ordinary(100), summary())
    const result = await value.github[method](12)
    expect(Array.isArray(result) ? result : result.comments).toHaveLength(
      method === "issue" ? 100 : 101,
    )
    expect(value.api.rest.issues.listComments.mock.calls.map(([params]) => params)).toEqual([
      expect.objectContaining({
        owner: "example",
        repo: "project",
        issue_number: 12,
        per_page: 100,
        page: 1,
      }),
      expect.objectContaining({
        owner: "example",
        repo: "project",
        issue_number: 12,
        per_page: 100,
        page: 2,
      }),
    ])
  })

  test("accepts exactly 100 ordinary comments without a next Link", async () => {
    const value = fixture()
    value.add(...ordinary(100))
    await value.github[method](12)
    expect(value.api.rest.issues.listComments).toHaveBeenCalledTimes(1)
  })

  test.each([
    "foreign author",
    "wrong type",
    "wrong repository",
    "wrong issue",
    "embedded marker",
    "duplicate prefix",
    "proposal marker",
    "job marker",
    "oversized",
  ])("%s does not receive a count allowance", async (kind) => {
    const value = fixture()
    value.add(...ordinary(100), invalidSummary(kind))
    await localFailure(value.github[method](12), "github_comments_limit")
  })

  test("a foreign marker does not cancel the legitimate summary allowance", async () => {
    const value = fixture()
    value.add(...ordinary(99), invalidSummary("foreign author"), summary())
    value.comments[99].id = 1000
    await value.github[method](12)
  })

  test.each(["valid", "malformed", "wrong scope"])(
    "a second bot-owned %s triage marker cancels the allowance",
    async (kind) => {
      const value = fixture()
      const second =
        kind === "valid"
          ? summary()
          : invalidSummary(kind === "malformed" ? "embedded marker" : "wrong issue")
      second.id = 1002
      value.add(...ordinary(99), summary(), second)
      await localFailure(value.github[method](12), "github_comments_limit")
    },
  )

  test("101 ordinary comments fail after both complete pages", async () => {
    const value = fixture()
    value.add(...ordinary(101))
    await localFailure(value.github[method](12), "github_comments_limit")
    expect(value.api.rest.issues.listComments).toHaveBeenCalledTimes(2)
  })

  test("102 raw comments fail before listing", async () => {
    const value = fixture()
    value.add(...ordinary(101), summary())
    await localFailure(value.github[method](12), "github_comments_limit")
    expect(value.api.rest.issues.listComments).not.toHaveBeenCalled()
  })

  test("an unexpected 102nd raw comment fails within two numbered pages", async () => {
    const value = fixture()
    value.add(...ordinary(101), summary())
    value.issue.comments = 101
    await localFailure(value.github[method](12), "github_read_limit")
    expect(value.api.rest.issues.listComments).toHaveBeenCalledTimes(2)
  })

  test("ordinary comment bytes cannot exceed 128 KiB", async () => {
    const value = fixture()
    value.add(
      { ...ordinary(1)[0], body: `${"é".repeat(contextBytes / 2)}x` },
      summary(summaryBytes - 1),
    )
    await localFailure(value.github[method](12), "github_read_limit")
  })

  test.each([
    "foreign author",
    "wrong type",
    "wrong repository",
    "wrong issue",
    "embedded marker",
    "duplicate prefix",
    "proposal marker",
    "job marker",
    "oversized",
  ])("%s does not receive a byte allowance", async (kind) => {
    const value = fixture()
    value.add({ ...ordinary(1)[0], body: "x".repeat(contextBytes - 1) }, invalidSummary(kind))
    await localFailure(value.github[method](12), "github_read_limit")
  })

  test("all other bot and proposal comments retain the ordinary count bound", async () => {
    const value = fixture()
    value.add(
      ...ordinary(101).map((comment) => ({
        ...comment,
        user: { id: 99, type: "Bot" },
        body: "<!-- reina:proposal:old -->",
      })),
    )
    await localFailure(value.github[method](12), "github_comments_limit")
  })

  test("all other bot comments retain the ordinary byte bound", async () => {
    const value = fixture()
    value.add({
      ...ordinary(1)[0],
      user: { id: 99, type: "Bot" },
      body: "x".repeat(contextBytes + 1),
    })
    await localFailure(value.github[method](12), "github_read_limit")
  })

  test.each(["number", "id"] as const)(
    "validates issue %s before reading comments",
    async (field) => {
      const value = fixture()
      value.issue[field] = field === "number" ? 13 : 0
      await expect(value.github[method](12)).rejects.toMatchObject({
        code: field === "number" ? "github_issue_mismatch" : "github_invalid_id",
      })
      expect(value.api.rest.issues.listComments).not.toHaveBeenCalled()
    },
  )

  test("rejects duplicate comment IDs across pages", async () => {
    const value = fixture()
    value.add(...ordinary(100), { ...summary(), id: 1 })
    await expect(value.github[method](12)).rejects.toMatchObject({
      code: "github_duplicate_comment",
    })
  })

  test("follows a next Link even on a partial first page", async () => {
    const value = fixture()
    value.add(...ordinary(1), summary())
    value.api.rest.issues.listComments
      .mockResolvedValueOnce({ data: [value.comments[0]], headers: { link: next } })
      .mockResolvedValueOnce({ data: [value.comments[1]], headers: { link: undefined } })
    await value.github[method](12)
    expect(value.api.rest.issues.listComments).toHaveBeenCalledTimes(2)
  })

  test("does not return a partial prefix when page 2 fails", async () => {
    const value = fixture()
    value.add(...ordinary(100), summary())
    value.api.rest.issues.listComments
      .mockResolvedValueOnce({ data: value.comments.slice(0, 100), headers: { link: next } })
      .mockRejectedValueOnce(Object.assign(new Error("not found"), { status: 404 }))
    await expect(value.github[method](12)).rejects.toMatchObject({
      code: "github_read_failed",
      status: 404,
    })
  })

  test("does not return a prefix with a next Link left on page 2", async () => {
    const value = fixture()
    value.add(...ordinary(1))
    value.links.set(1, next)
    value.links.set(2, next)
    value.api.rest.issues.listComments.mockResolvedValueOnce({ data: [], headers: { link: next } })
    await expect(value.github[method](12)).rejects.toMatchObject({ code: "github_incomplete_page" })
    value.api.rest.issues.listComments.mockClear()
    value.api.rest.issues.listComments.mockResolvedValue({
      data: value.comments,
      headers: { link: next },
    })
    await localFailure(value.github[method](12), "github_pagination_limit")
    expect(value.api.rest.issues.listComments).toHaveBeenCalledTimes(2)
  })

  test("does not accept 101 comments when page 2 still has a next Link", async () => {
    const value = fixture()
    value.add(...ordinary(100), summary())
    value.links.set(2, next)
    await localFailure(value.github[method](12), "github_pagination_limit")
  })

  test("does not return an incomplete list without a next Link", async () => {
    const value = fixture()
    value.add(...ordinary(100), summary())
    value.api.rest.issues.listComments.mockResolvedValueOnce({
      data: value.comments.slice(0, 100),
      headers: { link: undefined },
    })
    await localFailure(value.github[method](12), "github_issue_changed_during_read")
    expect(value.api.rest.issues.listComments).toHaveBeenCalledTimes(1)
  })

  test("a raw comment-count mismatch includes a local retry deadline", async () => {
    const value = fixture()
    value.add(...ordinary(99), summary())
    value.issue.comments++
    const error = await value.github[method](12).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(GitHubIssueDeferred)
    expect(error).toMatchObject({
      code: "github_issue_changed_during_read",
      retryAt: expect.any(Number),
    })
  })

  test.each(["issue", "comments", "page2"])(
    "a real %s rate limit still needs global backoff",
    async (phase) => {
      const value = fixture()
      const error = Object.assign(new Error("rate limited"), {
        status: 429,
        response: { headers: { "retry-after": "30" } },
      })
      if (phase === "issue") value.api.rest.issues.get.mockRejectedValueOnce(error)
      else {
        if (phase === "page2") {
          value.add(...ordinary(100), summary())
          value.api.rest.issues.listComments.mockResolvedValueOnce({
            data: value.comments.slice(0, 100),
            headers: { link: next },
          })
        }
        value.api.rest.issues.listComments.mockRejectedValueOnce(error)
      }
      const failure = await value.github[method](12).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(GitHubDeferred)
      expect(failure).toMatchObject({ code: "github_rate_limit", retryAt: expect.any(Number) })
      if (phase === "issue") expect(value.api.rest.issues.listComments).not.toHaveBeenCalled()
    },
  )
})

describe("total ordinary issue context", () => {
  test.each([false, true])(
    "accepts exactly 128 KiB plus a 64 KiB summary (multibyte=%s)",
    async (multibyte) => {
      const value = fixture()
      value.issue.title = ""
      const body = multibyte ? "é".repeat(contextBytes / 2) : "x".repeat(contextBytes)
      value.add({ ...ordinary(1)[0], body }, summary(summaryBytes))
      expect((await value.github.issue(12)).comments[0].body).toBe(body)
      expect(await value.github.comments(12)).toHaveLength(2)
    },
  )

  test("one extra human byte exceeds the fixed outer byte bound", async () => {
    const value = fixture()
    value.add({ ...ordinary(1)[0], body: "x".repeat(contextBytes + 1) }, summary(summaryBytes))
    await localFailure(value.github.issue(12), "github_read_limit")
  })

  test("title and body remain part of the 128 KiB ordinary bound", async () => {
    const value = fixture()
    value.issue.body = "é".repeat((contextBytes - 2) / 2)
    value.add(...ordinary(1), summary(summaryBytes))
    await value.github.issue(12)
    value.issue.body += "x"
    await localFailure(value.github.issue(12), "github_context_limit")
  })

  test("exactly 128 KiB without a summary remains accepted", async () => {
    const value = fixture()
    value.issue.body = "x".repeat(contextBytes - 1)
    await value.github.issue(12)
    value.issue.body += "x"
    await localFailure(value.github.issue(12), "github_context_limit")
  })
})
