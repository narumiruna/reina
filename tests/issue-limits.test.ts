import { describe, expect, test, vi } from "vitest"
import { GitHub, type GitHubClient, GitHubDeferred } from "../src/github/scanner.js"

function fixture() {
  const repository = { owner: "example", name: "project", id: 456, installationId: 789 }
  const issue = {
    id: 1012,
    number: 12,
    title: "x",
    body: "",
    labels: [],
    state: "open",
    comments: 0,
  }
  const comments: { id: number; body: string; user: { id: number } }[] = []
  let link: string | undefined
  const api = {
    auth: vi.fn(async () => ({ tokenType: "installation", installationId: 789 })),
    rest: {
      repos: {
        get: vi.fn(async () => ({
          data: { id: 456, name: "project", owner: { login: "example" } },
        })),
      },
      issues: {
        get: vi.fn(async () => ({ data: issue })),
        listComments: vi.fn(async () => ({ data: comments, headers: { link } })),
      },
    },
  }
  return {
    issue,
    comments,
    api,
    github: new GitHub(api as unknown as GitHubClient, repository, 99),
    nextPage() {
      link = '<https://api.github.com/untrusted?page=2>; rel="next"'
    },
  }
}

describe("issue-local evidence limits", () => {
  test.each([
    ["comment count", "github_comments_limit"],
    ["comment bytes", "github_read_limit"],
    ["total context bytes", "github_context_limit"],
    ["comment pagination", "github_pagination_limit"],
    ["comment count changed", "github_issue_changed_during_read"],
  ])("%s rejects incomplete evidence without global backoff", async (kind, code) => {
    const value = fixture()
    if (kind === "comment count") value.issue.comments = 101
    if (kind === "comment bytes") {
      value.comments.push({ id: 1, body: "x".repeat(131073), user: { id: 50 } })
      value.issue.comments = 1
    }
    if (kind === "total context bytes") value.issue.body = "x".repeat(131072)
    if (kind === "comment count changed") value.issue.comments = 1
    if (kind === "comment pagination") {
      for (let id = 1; id <= 100; id++) {
        value.comments.push({ id, body: "x", user: { id: 50 } })
      }
      value.issue.comments = 100
      value.nextPage()
    }
    const error = await value.github.issue(12).catch((error: unknown) => error)
    expect(error).toMatchObject({ code })
    expect(error).not.toBeInstanceOf(GitHubDeferred)
    expect(value.api.rest.issues.listComments.mock.calls.length).toBeLessThanOrEqual(1)
  })

  test("a comment-count mismatch includes a local retry deadline", async () => {
    const value = fixture()
    value.issue.comments = 1
    const error = await value.github.issue(12).catch((error: unknown) => error)
    expect(error).toMatchObject({
      code: "github_issue_changed_during_read",
      retryAt: expect.any(Number),
    })
    expect(error).not.toBeInstanceOf(GitHubDeferred)
  })

  test("exactly 100 comments are accepted without truncation", async () => {
    const value = fixture()
    for (let id = 1; id <= 100; id++) {
      value.comments.push({ id, body: "x", user: { id: 50 } })
    }
    value.issue.comments = 100
    expect((await value.github.issue(12)).comments).toHaveLength(100)
  })

  test("exactly 128 KiB of issue context is accepted", async () => {
    const value = fixture()
    value.issue.body = "x".repeat(131071)
    expect((await value.github.issue(12)).body).toHaveLength(131071)
  })

  test.each(["issue", "comments"])(
    "a real %s rate limit still needs global backoff",
    async (phase) => {
      const value = fixture()
      const error = Object.assign(new Error("rate limited"), {
        status: 429,
        response: { headers: { "retry-after": "30" } },
      })
      if (phase === "issue") value.api.rest.issues.get.mockRejectedValueOnce(error)
      else value.api.rest.issues.listComments.mockRejectedValueOnce(error)
      await expect(value.github.issue(12)).rejects.toMatchObject({ code: "github_rate_limit" })
      if (phase === "issue") expect(value.api.rest.issues.listComments).not.toHaveBeenCalled()
    },
  )
})
