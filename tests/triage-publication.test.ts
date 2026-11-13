import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Publisher } from "../src/github/publisher.js"
import { type GitHubClient, GitHubDeferred, GitHubOutcomeUnknown } from "../src/github/scanner.js"
import { ASSESSMENT_PROTOCOL_REVISION } from "../src/triage/assessment.js"
import { fingerprint } from "../src/triage/policy.js"
import { REVIEW_LABELS, type Review, reviewSchema } from "../src/triage/review.js"
import type { Issue } from "../src/types.js"

const repository = { owner: "octo-org", name: "example", id: 77, installationId: 88 }
const bot = { id: 99, type: "Bot", login: "reina[bot]" }
const now = Date.parse("2026-11-13T10:00:00Z")
const revision = "391d24a0-51c6-4843-90bc-f5fab237f111"
const nextRevision = "391d24a0-51c6-4843-90bc-f5fab237f222"
const marker = "<!-- reina:triage:77:123 -->"
const clone = <T>(value: T): T => structuredClone(value)
const response = <T>(data: T) => ({ data: clone(data), headers: {} })
const apiError = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error("untrusted remote diagnostics"), { status, response: { headers } })
type Comment = { id: number; body: string; user: typeof bot; created_at: string }

class MockAPI {
  installationId = repository.installationId
  metadata = { ...repository, owner: { login: repository.owner }, default_branch: "main" }
  issue = {
    id: 123,
    number: 12,
    title: "Missing reproduction details",
    body: "The documented result differs.",
    state: "open",
    labels: ["bug", "bot:approved", "fix_available"],
    pull_request: undefined as object | undefined,
  }
  comments: Comment[] = []
  hidden = false
  sha = "1".repeat(40)
  definitions = new Set<string>(REVIEW_LABELS)
  commentLink?: string
  writes: string[] = []
  onWrite?: (name: string) => void
  nextCommentId = 100

  private scoped(params: { owner: string; repo: string; request?: { retries: number } }) {
    expect(params.owner).toBe(repository.owner)
    expect(params.repo).toBe(repository.name)
    expect(params.request?.retries).toBe(0)
  }

  private write(name: string) {
    this.writes.push(name)
    this.onWrite?.(name)
  }

  rest = {
    repos: { get: vi.fn(async () => response(this.metadata)) },
    git: {
      getRef: vi.fn(async () =>
        response({ ref: "refs/heads/main", object: { sha: this.sha, type: "commit" } }),
      ),
    },
    issues: {
      get: vi.fn(async () =>
        response({ ...this.issue, comments: this.hidden ? 0 : this.comments.length }),
      ),
      listComments: vi.fn(async ({ page = 1, per_page = 100 } = {}) => {
        const comments = this.hidden ? [] : this.comments
        const end = page * per_page
        return {
          ...response(comments.slice(end - per_page, end)),
          headers: {
            link:
              this.commentLink ??
              (end < comments.length
                ? `<https://api.github.test/comments?page=${page + 1}>; rel="next"`
                : undefined),
          },
        }
      }),
      getComment: vi.fn(async (params: { comment_id: number; owner: string; repo: string }) => {
        this.scoped(params)
        const comment = this.comments.find((item) => item.id === params.comment_id)
        if (!comment) throw apiError(404)
        return response(comment)
      }),
      createComment: vi.fn(async (params: { body: string; owner: string; repo: string }) => {
        this.scoped(params)
        this.write("createComment")
        const comment = {
          id: this.nextCommentId++,
          body: params.body,
          user: clone(bot),
          created_at: new Date(now).toISOString(),
        }
        this.comments.push(comment)
        return response(comment)
      }),
      updateComment: vi.fn(
        async (params: { comment_id: number; body: string; owner: string; repo: string }) => {
          this.scoped(params)
          this.write("updateComment")
          const comment = this.comments.find((item) => item.id === params.comment_id)
          if (!comment) throw apiError(404)
          comment.body = params.body
          return response(comment)
        },
      ),
      getLabel: vi.fn(async (params: { name: string; owner: string; repo: string }) => {
        this.scoped(params)
        if (!this.definitions.has(params.name)) throw apiError(404)
        return response({ name: params.name, id: 1000 })
      }),
      addLabels: vi.fn(async (params: { labels: string[]; owner: string; repo: string }) => {
        this.scoped(params)
        expect(
          params.labels.every((name) => (REVIEW_LABELS as readonly string[]).includes(name)),
        ).toBe(true)
        this.write(`add:${params.labels.join(",")}`)
        this.issue.labels = [...new Set([...this.issue.labels, ...params.labels])]
        return response(this.issue.labels)
      }),
      removeLabel: vi.fn(async (params: { name: string; owner: string; repo: string }) => {
        this.scoped(params)
        expect((REVIEW_LABELS as readonly string[]).includes(params.name)).toBe(true)
        this.write(`remove:${params.name}`)
        this.issue.labels = this.issue.labels.filter((name) => name !== params.name)
        return response(this.issue.labels)
      }),
    },
  }

  client(): GitHubClient {
    return {
      auth: vi.fn(async () => ({ tokenType: "installation", installationId: this.installationId })),
      rest: this.rest,
    } as unknown as GitHubClient
  }

  evidence(): Issue {
    return {
      ref: { ...repository, number: this.issue.number, issueId: this.issue.id },
      title: this.issue.title,
      body: this.issue.body,
      labels: this.issue.labels,
      state: this.issue.state === "open" ? "open" : "closed",
      pullRequest: this.issue.pull_request !== undefined,
      comments: this.comments
        .filter((comment) => comment.user.id !== bot.id)
        .map((comment) => ({ id: comment.id, authorId: comment.user.id, body: comment.body })),
    }
  }

  comment(body: string, user = bot): Comment {
    const comment = {
      id: this.nextCommentId++,
      body,
      user: clone(user),
      created_at: new Date(now).toISOString(),
    }
    this.comments.push(comment)
    return comment
  }
}

function setup() {
  const api = new MockAPI()
  const publisher = new Publisher(api.client(), repository, bot.id)
  let durable: Review = {
    ref: { ...repository, number: 12, issueId: 123 },
    revision,
    binding: {
      fingerprint: fingerprint(api.evidence(), bot.id),
      baseBranch: "main",
      baseSha: api.sha,
      policyHash: "f".repeat(64),
      protocolRevision: ASSESSMENT_PROTOCOL_REVISION,
    },
    state: "assessed",
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    assessedAt: now,
    outcome: "needs_info",
    assessment: {
      kind: "bug",
      summary: "The report does not include reproduction steps.",
      missingInfo: ["Which public release shows this behavior?"],
      fix: {
        eligible: false,
        category: "defer",
        reason: "Reproduction details are missing.",
        proposedFix: "",
        affectedFiles: [],
        verificationPlan: [],
        requiresHumanDecision: false,
        risks: [],
      },
    },
  }
  const save = vi.fn((review: Review) => {
    reviewSchema.parse(review)
    expect(review.updatedAt).toBeGreaterThanOrEqual(durable.updatedAt)
    durable = clone(review)
  })
  return {
    api,
    publisher,
    save,
    get review() {
      return durable
    },
    run: (signal?: AbortSignal, current = publisher) =>
      current.review(clone(durable), save, signal),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})
afterEach(() => vi.useRealTimers())

describe("triage summary publication", () => {
  test("creates one stable summary, preserves unrelated labels and immutable proposal evidence", async () => {
    const op = setup()
    const proposal = op.api.comment(
      "<!-- reina:proposal:77:123:old -->\nImmutable approval evidence",
    )
    const result = await op.run()
    expect(result).toMatchObject({ state: "complete", commentId: 101, publishedRevision: revision })
    expect(op.api.comments[1].body.startsWith(`${marker}\n`)).toBe(true)
    expect(op.api.comments[1].body).toContain("Next action: needs_info")
    expect(op.api.comments[1].body).toContain(new Date(now).toISOString())
    expect(op.api.comments[1].body).toContain("Triage did not modify code or verify a fix")
    expect(proposal.body).toBe("<!-- reina:proposal:77:123:old -->\nImmutable approval evidence")
    expect(op.api.issue.labels).toEqual(
      expect.arrayContaining([
        "bug",
        "bot:approved",
        "fix_available",
        "bot:needs-info",
        "bot:triaged",
      ]),
    )
    expect(op.api.writes.at(-1)).toBe("add:bot:triaged")
    expect(
      op.save.mock.calls.some(
        ([review]) => review.commentId === 101 && review.state === "assessed",
      ),
    ).toBe(true)
    const writes = clone(op.api.writes)
    await op.run()
    await op.run(undefined, new Publisher(op.api.client(), repository, bot.id))
    expect(op.api.writes).toEqual(writes)
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test.each(["count", "context-bytes"])(
    "publishes and reconciles a summary with 100 ordinary comments at the %s limit",
    async (limit) => {
      const op = setup()
      const budget =
        128 * 1024 - Buffer.byteLength(op.api.issue.title) - Buffer.byteLength(op.api.issue.body)
      const size = Math.floor(budget / 100)
      for (let index = 0; index < 100; index++) {
        const content =
          limit === "context-bytes"
            ? "x".repeat(size + (index < budget % 100 ? 1 : 0))
            : `Evidence ${index}`
        op.api.comment(content, { ...bot, id: 101, type: "User" })
      }
      op.review.binding.fingerprint = fingerprint(op.api.evidence(), bot.id)
      await op.run()
      const id = op.review.commentId
      expect(op.review).toMatchObject({ state: "complete", publishedRevision: revision })
      expect(op.api.comments).toHaveLength(101)
      expect(op.api.issue.labels).toContain("bot:triaged")
      expect(op.api.rest.issues.listComments).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, per_page: 100, issue_number: 12 }),
      )
      const writes = clone(op.api.writes)
      await op.run()
      expect(op.review).toMatchObject({ state: "complete", commentId: id })
      expect(op.api.writes).toEqual(writes)
      expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
      expect(op.api.rest.issues.updateComment).not.toHaveBeenCalled()
    },
  )

  test("updates the same comment for a new revision and outcome", async () => {
    const op = setup()
    await op.run()
    const id = op.review.commentId
    op.review.revision = nextRevision
    op.review.state = "assessed"
    delete op.review.publishedRevision
    op.review.outcome = "needs_human"
    if (!op.review.assessment) throw new Error("missing test assessment")
    op.review.assessment.summary = "A maintainer must decide the behavior."
    op.review.assessment.missingInfo = []
    op.review.assessment.fix.requiresHumanDecision = true
    await op.run()
    expect(op.review.commentId).toBe(id)
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(op.api.rest.issues.updateComment).toHaveBeenCalledTimes(1)
    expect(op.api.comments[0].body).toContain("Next action: needs_human")
    expect(op.api.issue.labels).not.toContain("bot:needs-info")
    expect(op.api.issue.labels).toContain("bot:needs-human")
    expect(op.review.publishedRevision).toBe(nextRevision)
  })

  test("publication timestamps stay monotonic after clock rollback", async () => {
    const op = setup()
    vi.setSystemTime(now - 60_000)
    await op.run()
    expect(op.review).toMatchObject({ state: "complete", updatedAt: now })
    vi.setSystemTime(now - 120_000)
    await op.run()
    expect(op.review.updatedAt).toBe(now)
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("a fix candidate does not publish fix_available or grant approval", async () => {
    const op = setup()
    op.api.issue.labels = ["bug"]
    op.review.outcome = "fix_candidate"
    await op.run()
    expect(op.api.issue.labels).toEqual(["bug", "bot:triaged"])
    expect(op.api.comments[0].body).toContain("does not grant approval")
  })

  test("renders bounded model data without active links, mentions, Markdown, HTML, or commands", async () => {
    const op = setup()
    const unsafe =
      "@maintainer https://evil.test/a [click](https://evil.test) <script>x</script>\n/approve #12 <!-- reina:triage:evil --> `cmd`"
    if (!op.review.assessment) throw new Error("missing test assessment")
    op.review.assessment.summary = unsafe
    op.review.assessment.missingInfo = [unsafe]
    op.review.assessment.fix.reason = unsafe
    await op.run()
    const body = op.api.comments[0].body
    expect(body).not.toContain("@maintainer")
    expect(body).not.toContain("https://")
    expect(body).not.toContain("evil.test")
    expect(body).not.toContain("<script>")
    expect(body).not.toContain("\n/approve")
    expect(body).not.toContain("#12")
    expect(body).toContain("&lt;script&gt;")
    expect(body.split("<!-- reina:triage:")).toHaveLength(2)
    expect(Buffer.byteLength(body)).toBeLessThan(64 * 1024)
  })

  test("rejects invalid or oversized assessments before any write", async () => {
    const op = setup()
    if (!op.review.assessment) throw new Error("missing test assessment")
    op.review.assessment.summary = "x".repeat(1001)
    await expect(op.run()).rejects.toThrow()
    expect(op.api.writes).toEqual([])
  })

  test.each(["repository", "installation", "issue", "pull_request"])(
    "checks %s identity before mutations",
    async (field) => {
      const op = setup()
      if (field === "repository") op.api.metadata.id++
      if (field === "installation") op.api.installationId++
      if (field === "issue") op.api.issue.id++
      if (field === "pull_request") op.api.issue.pull_request = {}
      await expect(op.run()).rejects.toThrow()
      expect(op.api.writes).toEqual([])
    },
  )

  test("rejects a review for a different repository before reading GitHub", async () => {
    const op = setup()
    op.review.ref.installationId++
    await expect(op.run()).rejects.toMatchObject({ code: "publication_review_mismatch" })
    expect(op.api.rest.repos.get).not.toHaveBeenCalled()
  })
})

describe("durable comment delivery", () => {
  test("saves intent before POST and confirms ID before label writes", async () => {
    const op = setup()
    op.api.onWrite = (name) => {
      if (name === "createComment") {
        expect(op.review.commentIntent).toBe(true)
        expect(op.review.commentRetryAt).toBeUndefined()
      }
      if (name.startsWith("add:")) expect(op.review.commentId).toBe(100)
    }
    await op.run()
  })

  test("reconciles an accepted create with a lost response", async () => {
    const op = setup()
    const create = op.api.rest.issues.createComment.getMockImplementation()
    if (!create) throw new Error("missing test implementation")
    op.api.rest.issues.createComment.mockImplementationOnce(async (params) => {
      await create(params)
      throw apiError(500)
    })
    await op.run()
    await op.run()
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(op.review.commentId).toBe(100)
  })

  test("an ambiguous absence never permits another POST, including after restart", async () => {
    const op = setup()
    op.api.rest.issues.createComment.mockRejectedValueOnce(apiError(500))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    expect(op.review.commentIntent).toBe(true)
    await expect(
      op.run(undefined, new Publisher(op.api.client(), repository, bot.id)),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("delayed visibility reconciles an accepted create without reposting", async () => {
    const op = setup()
    const create = op.api.rest.issues.createComment.getMockImplementation()
    if (!create) throw new Error("missing test implementation")
    op.api.rest.issues.createComment.mockImplementationOnce(async (params) => {
      await create(params)
      op.api.hidden = true
      throw apiError(500)
    })
    await expect(op.run()).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    await expect(op.run()).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    op.api.hidden = false
    await op.run()
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test.each([403, 429])("a definite %s rejection grants one durable retry", async (status) => {
    const op = setup()
    op.api.rest.issues.createComment.mockRejectedValueOnce(apiError(status, { "retry-after": "1" }))
    await expect(op.run()).rejects.toMatchObject({ retryAt: now + 1000 })
    expect(op.review.commentRetryAt).toBe(now + 1000)
    await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    vi.setSystemTime(now + 1000)
    op.api.onWrite = (name) => {
      if (name === "createComment") expect(op.review.commentRetryAt).toBeUndefined()
    }
    await op.run(undefined, new Publisher(op.api.client(), repository, bot.id))
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(2)
  })

  test("a consumed retry grant is not reused after an ambiguous replay", async () => {
    const op = setup()
    op.api.rest.issues.createComment.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
    vi.setSystemTime(now + 1000)
    op.api.rest.issues.createComment.mockRejectedValueOnce(apiError(500))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    expect(op.review.commentRetryAt).toBeUndefined()
    await expect(op.run()).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(2)
  })

  test("503 Retry-After does not authorize another POST", async () => {
    const op = setup()
    op.api.rest.issues.createComment.mockRejectedValueOnce(apiError(503, { "retry-after": "1" }))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
    expect(op.review.commentRetryAt).toBeUndefined()
    vi.setSystemTime(now + 1000)
    await expect(op.run()).rejects.toBeInstanceOf(GitHubOutcomeUnknown)
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("a lost update response is repaired on the same comment without another create", async () => {
    const op = setup()
    await op.run()
    op.review.state = "assessed"
    delete op.review.publishedRevision
    if (!op.review.assessment) throw new Error("missing test assessment")
    op.review.assessment.summary = "An updated summary."
    const update = op.api.rest.issues.updateComment.getMockImplementation()
    if (!update) throw new Error("missing test implementation")
    op.api.rest.issues.updateComment.mockImplementationOnce(async (params) => {
      await update(params)
      throw apiError(500)
    })
    await expect(op.run()).rejects.toThrow()
    expect(op.api.issue.labels).not.toContain("bot:triaged")
    await op.run()
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(op.api.rest.issues.updateComment).toHaveBeenCalledTimes(1)
    expect(op.review.state).toBe("complete")
  })

  test("a stored ID for another issue never grants permission to edit it", async () => {
    const op = setup()
    op.review.commentId = 777
    op.api.rest.issues.getComment.mockResolvedValueOnce(
      response({
        id: 777,
        body: `${marker}\nWrong issue`,
        user: bot,
        created_at: new Date(now).toISOString(),
      }),
    )
    await expect(op.run()).rejects.toMatchObject({ code: "publication_comment_conflict" })
    expect(op.api.rest.issues.updateComment).not.toHaveBeenCalled()
    expect(op.api.rest.issues.createComment).not.toHaveBeenCalled()
  })

  test("recreates a deleted stored comment only after a complete list and GET 404", async () => {
    const op = setup()
    await op.run()
    const previous = op.review.commentId
    op.api.comments = []
    await op.run()
    expect(op.api.rest.issues.getComment).toHaveBeenCalledWith(
      expect.objectContaining({
        comment_id: previous,
        owner: repository.owner,
        repo: repository.name,
      }),
    )
    expect(op.review.commentId).not.toBe(previous)
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(2)
  })

  test("a stored comment omitted from a list but still readable is not recreated", async () => {
    const op = setup()
    await op.run()
    op.api.hidden = true
    await expect(op.run()).rejects.toMatchObject({ code: "publication_comment_conflict" })
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test.each(["wrong-marker", "missing-marker", "owned-duplicate"])(
    "a confirmed %s conflict revokes a previous completion without changing comments or other labels",
    async (variant) => {
      const op = setup()
      await op.run()
      const identity = {
        commentId: op.review.commentId,
        commentIntent: op.review.commentIntent,
        assessment: clone(op.review.assessment),
      }
      op.api.issue.labels.push("bot:needs-human", "bot:triage-failed")
      if (variant === "wrong-marker")
        op.api.comments[0].body = "<!-- reina:triage:77:456 -->\nOther issue"
      if (variant === "missing-marker") op.api.comments[0].body = "Summary without a marker"
      if (variant === "owned-duplicate") op.api.comment(`${marker}\nDuplicate owned summary`)
      const comments = clone(op.api.comments)
      const labels = op.api.issue.labels.filter((name) => name !== "bot:triaged")
      op.api.writes = []
      await expect(op.run()).rejects.toMatchObject({ code: "publication_comment_conflict" })
      expect(op.review).toMatchObject({ ...identity, state: "assessed" })
      expect(op.review.publishedRevision).toBeUndefined()
      expect(op.api.issue.labels).toEqual(labels)
      expect(op.api.writes).toEqual(["remove:bot:triaged"])
      expect(op.api.comments).toEqual(comments)
      expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
      expect(op.api.rest.issues.updateComment).not.toHaveBeenCalled()
      if (variant === "missing-marker")
        expect(op.api.rest.issues.getComment).toHaveBeenCalledWith(
          expect.objectContaining({ comment_id: identity.commentId }),
        )
    },
  )

  test("incomplete comment reads do not authorize recreation", async () => {
    const op = setup()
    await op.run()
    op.api.comments = []
    op.api.commentLink = '<https://untrusted.test/?page=2>; rel="next"'
    await expect(op.run()).rejects.toThrow()
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(op.api.rest.issues.getComment).not.toHaveBeenCalled()
  })

  test.each(["foreign-author", "wrong-type"])(
    "ignores %s marker text instead of granting ownership",
    async (variant) => {
      const op = setup()
      const user = variant === "foreign-author" ? { ...bot, id: 101 } : { ...bot, type: "User" }
      const foreign = op.api.comment(`${marker}\nUntrusted marker text`, user)
      const original = foreign.body
      op.review.binding.fingerprint = fingerprint(op.api.evidence(), bot.id)
      await op.run()
      expect(op.review.state).toBe("complete")
      expect(op.review.commentId).not.toBe(foreign.id)
      expect(foreign.body).toBe(original)
      expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
      expect(op.api.rest.issues.updateComment).not.toHaveBeenCalled()
    },
  )

  test("a foreign marker beside the owned summary cannot block its reconciliation", async () => {
    const op = setup()
    await op.run()
    const owned = op.review.commentId
    const foreign = op.api.comment(`${marker}\nCopied marker`, { ...bot, id: 101, type: "User" })
    op.review.revision = nextRevision
    op.review.state = "assessed"
    delete op.review.publishedRevision
    op.review.binding.fingerprint = fingerprint(op.api.evidence(), bot.id)
    await op.run()
    expect(op.review).toMatchObject({ state: "complete", commentId: owned })
    expect(foreign.body).toBe(`${marker}\nCopied marker`)
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(op.api.rest.issues.updateComment).not.toHaveBeenCalled()
  })

  test.each(["multiple", "wrong-marker", "embedded", "proposal-marker", "duplicate-marker"])(
    "fails closed on %s summary markers",
    async (variant) => {
      const op = setup()
      let content = `${marker}\nExisting summary`
      if (variant === "wrong-marker") content = "<!-- reina:triage:77:456 -->\nOther issue"
      if (variant === "embedded") content = `Untrusted prefix\n${content}`
      if (variant === "proposal-marker") content += "\n<!-- reina:proposal:77:123:old -->"
      if (variant === "duplicate-marker") content += `\n${marker}`
      op.api.comment(content, bot)
      if (variant === "multiple") op.api.comment(`${marker}\nAnother summary`)
      op.review.binding.fingerprint = fingerprint(op.api.evidence(), bot.id)
      await expect(op.run()).rejects.toMatchObject({ code: "publication_comment_conflict" })
      expect(op.api.rest.issues.createComment).not.toHaveBeenCalled()
      expect(op.api.rest.issues.updateComment).not.toHaveBeenCalled()
      expect(op.api.issue.labels).not.toContain("bot:triaged")
    },
  )
})

describe("label projection and failure recovery", () => {
  test.each(["bot:needs-info", "bot:triaged"])(
    "missing definition %s never auto-creates a label",
    async (name) => {
      const op = setup()
      op.api.definitions.delete(name)
      await expect(op.run()).rejects.toThrow()
      expect(op.review.state).toBe("assessed")
      expect(op.review.commentId).toBe(100)
      expect(op.api.issue.labels).not.toContain("bot:triaged")
      expect(
        op.api.rest.issues.addLabels.mock.calls.every(([params]) => !params.labels.includes(name)),
      ).toBe(true)
      op.api.definitions.add(name)
      await op.run()
      expect(op.review.state).toBe("complete")
      expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    },
  )

  test("partial outcome writes do not establish reviewed completion", async () => {
    const op = setup()
    op.api.rest.issues.addLabels.mockResolvedValueOnce(response([]))
    await expect(op.run()).rejects.toMatchObject({ code: "publication_labels_unconfirmed" })
    expect(op.review.state).toBe("assessed")
    expect(op.api.issue.labels).not.toContain("bot:triaged")
    await op.run()
    expect(op.review.state).toBe("complete")
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("a definition with a different name fails before adding the missing label", async () => {
    const op = setup()
    op.api.rest.issues.getLabel.mockResolvedValueOnce(response({ name: "bot:approved", id: 1000 }))
    await expect(op.run()).rejects.toMatchObject({ code: "publication_label_mismatch" })
    expect(op.api.rest.issues.addLabels).not.toHaveBeenCalled()
  })

  test("an unconfirmed final reviewed label keeps publication pending", async () => {
    const op = setup()
    const add = op.api.rest.issues.addLabels.getMockImplementation()
    if (!add) throw new Error("missing test implementation")
    op.api.rest.issues.addLabels.mockImplementation(async (params) =>
      params.labels.includes("bot:triaged") ? response([]) : add(params),
    )
    await expect(op.run()).rejects.toMatchObject({ code: "publication_labels_unconfirmed" })
    expect(op.review.state).toBe("assessed")
    expect(op.review.publishedRevision).toBeUndefined()
  })

  test("a summary changed during final label publication cannot become complete", async () => {
    const op = setup()
    op.api.onWrite = (name) => {
      if (name === "add:bot:triaged") op.api.comments[0].body += "\nUnexpected change"
    }
    await expect(op.run()).rejects.toMatchObject({ code: "publication_comment_conflict" })
    expect(op.review.state).toBe("assessed")
    expect(op.review.publishedRevision).toBeUndefined()
    expect(op.api.issue.labels).not.toContain("bot:triaged")
    expect(op.api.issue.labels).toContain("bot:needs-info")
    expect(op.api.writes.at(-1)).toBe("remove:bot:triaged")
    expect(op.api.rest.issues.updateComment).not.toHaveBeenCalled()
  })

  test("rate-limited labels keep the confirmed summary ID for retry", async () => {
    const op = setup()
    op.api.rest.issues.addLabels.mockRejectedValueOnce(apiError(429, { "retry-after": "3600" }))
    await expect(op.run()).rejects.toMatchObject({ retryAt: now + 3_600_000 })
    expect(op.review.commentId).toBe(100)
    expect(op.review.state).toBe("assessed")
    expect(op.review.publishedRevision).toBeUndefined()
    await op.run()
    expect(op.review.state).toBe("complete")
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test.each(["read", "write"])(
    "cleanup %s rate limits follow durable revocation and stop later requests",
    async (operation) => {
      const op = setup()
      await op.run()
      const id = op.review.commentId
      op.api.comments[0].body = "Summary without a marker"
      const reads = () => [
        op.api.rest.repos.get.mock.calls.length,
        op.api.rest.issues.get.mock.calls.length,
        op.api.rest.issues.listComments.mock.calls.length,
        op.api.rest.issues.getComment.mock.calls.length,
        op.api.rest.issues.getLabel.mock.calls.length,
        op.api.rest.git.getRef.mock.calls.length,
      ]
      let atDeferral: number[] = []
      const defer = async () => {
        expect(op.review).toMatchObject({ state: "assessed", commentId: id, commentIntent: true })
        expect(op.review.publishedRevision).toBeUndefined()
        atDeferral = reads()
        throw apiError(429, { "retry-after": "3600" })
      }
      if (operation === "write") {
        op.api.rest.issues.removeLabel.mockImplementationOnce(defer)
      } else {
        const get = op.api.rest.issues.getComment.getMockImplementation()
        if (!get) throw new Error("missing test implementation")
        op.api.rest.issues.getComment.mockImplementationOnce(async (params) => {
          const comment = await get(params)
          op.api.rest.issues.get.mockImplementationOnce(defer)
          return comment
        })
      }
      op.api.writes = []
      await expect(op.run()).rejects.toMatchObject({ retryAt: now + 3_600_000 })
      expect(op.review).toMatchObject({ state: "assessed", commentId: id, commentIntent: true })
      expect(op.review.publishedRevision).toBeUndefined()
      expect(reads()).toEqual(atDeferral)
      expect(op.api.writes).toEqual([])
      expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
      expect(op.api.rest.issues.updateComment).not.toHaveBeenCalled()
    },
  )

  test.each([401, 403, 429])(
    "an uncertain %s read after completion does not trigger conflict cleanup",
    async (status) => {
      const op = setup()
      await op.run()
      const durable = clone(op.review)
      const writes = clone(op.api.writes)
      op.api.rest.issues.listComments.mockRejectedValueOnce(
        apiError(status, status === 429 ? { "retry-after": "3600" } : {}),
      )
      await expect(op.run()).rejects.toThrow()
      expect(op.review).toEqual(durable)
      expect(op.api.writes).toEqual(writes)
      expect(op.api.rest.issues.removeLabel).not.toHaveBeenCalled()
    },
  )

  test("read cooldowns retain an unused rejection grant", async () => {
    const op = setup()
    op.api.rest.issues.createComment.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
    op.api.rest.issues.listComments.mockRejectedValueOnce(apiError(429, { "retry-after": "3600" }))
    await expect(op.run()).rejects.toMatchObject({ retryAt: now + 3_600_000 })
    expect(op.review.commentRetryAt).toBe(now + 1000)
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("failure without a previous comment publishes only triage-failed", async () => {
    const op = setup()
    op.review.state = "failed"
    op.review.error = "triage_invalid_output"
    delete op.review.assessment
    delete op.review.outcome
    delete op.review.assessedAt
    op.api.issue.labels.push(...REVIEW_LABELS)
    const result = await op.run()
    expect(result.state).toBe("failed")
    expect(result.publishedRevision).toBe(revision)
    expect(result.commentId).toBeUndefined()
    expect(op.api.rest.issues.createComment).not.toHaveBeenCalled()
    expect(op.api.issue.labels).toEqual([
      "bug",
      "bot:approved",
      "fix_available",
      "bot:triage-failed",
    ])
  })

  test("failed assessment replaces an old summary without retaining valid-result claims", async () => {
    const op = setup()
    await op.run()
    op.review.state = "failed"
    delete op.review.publishedRevision
    delete op.review.assessment
    delete op.review.assessedAt
    delete op.review.outcome
    op.review.error = "triage_invalid_output"
    await op.run()
    expect(op.api.comments[0].body).toContain("Assessment failed")
    expect(op.api.comments[0].body).not.toContain("Next action:")
    expect(op.api.issue.labels).toContain("bot:triage-failed")
    expect(op.api.issue.labels).not.toContain("bot:triaged")
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(op.review.state).toBe("failed")
  })

  test("a restored oversized escaped assessment cannot block stale label cleanup", async () => {
    const op = setup()
    await op.run()
    const id = op.review.commentId
    if (!op.review.assessment) throw new Error("missing test assessment")
    op.review.assessment.summary = "&".repeat(1_000)
    op.review.assessment.missingInfo = Array.from({ length: 5 }, () => "&".repeat(300))
    op.review.assessment.fix.reason = "&".repeat(2_000)
    op.review.assessment.fix.risks = Array.from({ length: 10 }, () => "&".repeat(1_000))
    op.review.state = "stale"
    op.review.inactiveReason = "changed"
    delete op.review.publishedRevision
    await op.run()
    expect(op.review).toMatchObject({ state: "stale", commentId: id })
    expect(REVIEW_LABELS.every((name) => !op.api.issue.labels.includes(name))).toBe(true)
    expect(Buffer.byteLength(op.api.comments[0].body)).toBeLessThan(65_536)
    expect(op.api.comments[0].body).toContain("previous details are omitted")
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("stale marker conflicts do not preserve active review labels", async () => {
    const op = setup()
    op.api.comment(`Untrusted prefix\n${marker}\nInvalid bot-owned summary`, bot)
    op.api.issue.labels.push(...REVIEW_LABELS)
    op.review.state = "stale"
    op.review.inactiveReason = "changed"
    await expect(op.run()).rejects.toMatchObject({ code: "publication_comment_conflict" })
    expect(REVIEW_LABELS.every((name) => !op.api.issue.labels.includes(name))).toBe(true)
    expect(op.api.rest.issues.updateComment).not.toHaveBeenCalled()
  })

  test("an unavailable issue does not invent a successful projection", async () => {
    const op = setup()
    op.review.state = "stale"
    op.review.inactiveReason = "unavailable"
    op.api.rest.issues.get.mockRejectedValueOnce(apiError(404))
    await expect(op.run()).rejects.toMatchObject({ status: 404 })
    expect(op.review.publishedRevision).toBeUndefined()
    expect(op.api.writes).toEqual([])
  })

  test.each(["changed", "closed", "skipped"] as const)(
    "stale %s marks an existing summary inactive and removes only four review labels",
    async (reason) => {
      const op = setup()
      await op.run()
      op.review.state = "stale"
      op.review.inactiveReason = reason
      delete op.review.publishedRevision
      if (reason === "closed") op.api.issue.state = "closed"
      if (reason === "skipped") op.api.issue.labels.push("bot:skip")
      op.api.issue.labels.push("bot:needs-human", "bot:triage-failed")
      await op.run()
      expect(op.review).toMatchObject({
        state: "stale",
        inactiveReason: reason,
        publishedRevision: revision,
      })
      expect(op.api.comments[0].body).toContain(reason === "changed" ? "stale" : "inactive")
      expect(REVIEW_LABELS.every((name) => !op.api.issue.labels.includes(name))).toBe(true)
      expect(op.api.issue.labels).toEqual(
        expect.arrayContaining(["bug", "bot:approved", "fix_available"]),
      )
      if (reason === "skipped") expect(op.api.issue.labels).toContain("bot:skip")
      expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    },
  )

  test.each(["fingerprint", "head", "branch", "closed", "skipped"])(
    "invalidates a changed %s without posting a new summary or reviewed label",
    async (change) => {
      const op = setup()
      if (change === "fingerprint") op.api.issue.body += " Changed evidence."
      if (change === "head") op.api.sha = "2".repeat(40)
      if (change === "branch") op.review.binding.baseBranch = "release"
      if (change === "closed") op.api.issue.state = "closed"
      if (change === "skipped") op.api.issue.labels.push("bot:skip")
      await op.run()
      expect(op.review.state).toBe("stale")
      expect(op.api.rest.issues.createComment).not.toHaveBeenCalled()
      expect(op.api.issue.labels).not.toContain("bot:triaged")
    },
  )

  test("evidence changed after comment creation is invalidated before the reviewed label", async () => {
    const op = setup()
    op.api.onWrite = (name) => {
      if (name === "createComment") op.api.issue.body += " New evidence."
    }
    await op.run()
    expect(op.review.state).toBe("stale")
    expect(op.api.comments[0].body).toContain("stale")
    expect(op.api.issue.labels).not.toContain("bot:triaged")
    expect(op.api.writes).not.toContain("add:bot:triaged")
  })

  test("a base change after outcome labels is checked before bot:triaged", async () => {
    const op = setup()
    op.api.onWrite = (name) => {
      if (name === "add:bot:needs-info") op.api.sha = "2".repeat(40)
    }
    await op.run()
    expect(op.review.state).toBe("stale")
    expect(op.api.issue.labels).not.toContain("bot:triaged")
    expect(op.api.writes).not.toContain("add:bot:triaged")
  })

  test("legacy labels allow only the four new controlled names and never approval additions", async () => {
    const op = setup()
    await op.publisher.labels(12, ["bot:needs-info"], [])
    expect(op.api.rest.issues.getLabel).toHaveBeenCalled()
    for (const name of ["bot:approved", "bot:skip", "enhancement", "bot:unknown"])
      await expect(op.publisher.labels(12, [name], [])).rejects.toMatchObject({
        code: "publication_invalid_labels",
      })
    op.api.definitions.delete("bot:triaged")
    await expect(op.publisher.labels(12, ["bot:triaged"], [])).rejects.toThrow()
    expect(op.api.issue.labels).not.toContain("bot:triaged")
  })
})

describe("publication cancellation and revision CAS", () => {
  test("a failed intent CAS makes no create request", async () => {
    const op = setup()
    const save = (review: Review) => {
      if (review.commentIntent) throw new Error("stale revision CAS")
      op.save(review)
    }
    await expect(op.publisher.review(op.review, save)).rejects.toThrow("stale revision CAS")
    expect(op.api.writes).toEqual([])
  })

  test("a failed retry-consumption CAS cannot replay the POST", async () => {
    const op = setup()
    op.api.rest.issues.createComment.mockRejectedValueOnce(apiError(429, { "retry-after": "1" }))
    await expect(op.run()).rejects.toBeInstanceOf(GitHubDeferred)
    vi.setSystemTime(now + 1000)
    const save = (review: Review) => {
      if (review.commentIntent && review.commentRetryAt === undefined)
        throw new Error("CAS rejected")
      op.save(review)
    }
    await expect(op.publisher.review(op.review, save)).rejects.toThrow("CAS rejected")
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(op.review.commentRetryAt).toBe(now + 1000)
  })

  test("a failed ID save stops all later writes but restart reconciles the accepted create", async () => {
    const op = setup()
    const save = (review: Review) => {
      if (review.commentId) throw new Error("CAS rejected")
      op.save(review)
    }
    await expect(op.publisher.review(op.review, save)).rejects.toThrow("CAS rejected")
    expect(op.api.writes).toEqual(["createComment"])
    await op.run()
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
  })

  test("CAS revocation after outcome publication stops the final reviewed label", async () => {
    const op = setup()
    let revoked = false
    op.api.onWrite = (name) => {
      if (name === "add:bot:needs-info") revoked = true
    }
    const save = (review: Review) => {
      if (revoked) throw new Error("CAS revoked")
      op.save(review)
    }
    await expect(op.publisher.review(op.review, save)).rejects.toThrow("CAS revoked")
    expect(op.api.writes).not.toContain("add:bot:triaged")
    expect(op.review.state).toBe("assessed")
  })

  test("a CAS error with status 404 is not swallowed as a missing label", async () => {
    const op = setup()
    op.api.issue.labels.push("bot:triaged")
    let saves = 0
    const save = (review: Review) => {
      if (++saves === 2) throw apiError(404)
      op.save(review)
    }
    await expect(op.publisher.review(op.review, save)).rejects.toMatchObject({ status: 404 })
    expect(op.api.writes).toEqual([])
  })

  test("a failed conflict-revocation CAS prevents cleanup writes", async () => {
    const op = setup()
    await op.run()
    op.api.comments[0].body = "Summary without a marker"
    op.api.writes = []
    const save = (review: Review) => {
      if (review.state === "assessed") throw new Error("CAS revoked")
      op.save(review)
    }
    await expect(op.publisher.review(op.review, save)).rejects.toThrow("CAS revoked")
    expect(op.api.writes).toEqual([])
    expect(op.api.rest.issues.removeLabel).not.toHaveBeenCalled()
    expect(op.review.state).toBe("complete")
  })

  test("a cleanup-write CAS with status 404 is not treated as a missing label", async () => {
    const op = setup()
    await op.run()
    op.api.comments[0].body = "Summary without a marker"
    op.api.writes = []
    let revocations = 0
    const save = (review: Review) => {
      if (review.state === "assessed" && ++revocations === 2) throw apiError(404)
      op.save(review)
    }
    await expect(op.publisher.review(op.review, save)).rejects.toMatchObject({ status: 404 })
    expect(op.api.writes).toEqual([])
    expect(op.api.rest.issues.removeLabel).not.toHaveBeenCalled()
    expect(op.review.state).toBe("assessed")
    expect(op.review.publishedRevision).toBeUndefined()
  })

  test("abort during conflict cleanup prevents the remote label write", async () => {
    const op = setup()
    await op.run()
    op.api.comments[0].body = "Summary without a marker"
    op.api.writes = []
    const controller = new AbortController()
    const read = op.api.rest.issues.get.getMockImplementation()
    if (!read) throw new Error("missing test implementation")
    op.api.rest.issues.get.mockImplementation(async () => {
      if (op.review.state === "assessed") controller.abort(new Error("cleanup cancelled"))
      return read()
    })
    await expect(op.run(controller.signal)).rejects.toThrow("cleanup cancelled")
    expect(op.api.writes).toEqual([])
    expect(op.api.rest.issues.removeLabel).not.toHaveBeenCalled()
    expect(op.review.state).toBe("assessed")
    expect(op.review.publishedRevision).toBeUndefined()
  })

  test("abort during the cleanup-write CAS prevents the remote label write", async () => {
    const op = setup()
    await op.run()
    op.api.comments[0].body = "Summary without a marker"
    op.api.writes = []
    const controller = new AbortController()
    let revocations = 0
    const save = (review: Review) => {
      op.save(review)
      if (review.state === "assessed" && ++revocations === 2)
        controller.abort(new Error("cleanup CAS cancelled"))
    }
    await expect(op.publisher.review(op.review, save, controller.signal)).rejects.toThrow(
      "cleanup CAS cancelled",
    )
    expect(op.api.writes).toEqual([])
    expect(op.api.rest.issues.removeLabel).not.toHaveBeenCalled()
    expect(op.review.state).toBe("assessed")
    expect(op.review.publishedRevision).toBeUndefined()
  })

  test("pre-aborted publication has no reads or writes", async () => {
    const op = setup()
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(op.run(controller.signal)).rejects.toThrow("cancelled")
    expect(op.api.rest.repos.get).not.toHaveBeenCalled()
    expect(op.api.writes).toEqual([])
  })

  test("abort during a read prevents late writes", async () => {
    const op = setup()
    const controller = new AbortController()
    const read = op.api.rest.issues.listComments.getMockImplementation()
    if (!read) throw new Error("missing test implementation")
    op.api.rest.issues.listComments.mockImplementationOnce(async () => {
      controller.abort(new Error("cancelled during read"))
      return read()
    })
    await expect(op.run(controller.signal)).rejects.toThrow("cancelled during read")
    expect(op.api.writes).toEqual([])
  })

  test("abort after create stops late labels; restart reconciles without another POST", async () => {
    const op = setup()
    const controller = new AbortController()
    op.api.onWrite = () => controller.abort(new Error("cancelled after write"))
    await expect(op.run(controller.signal)).rejects.toThrow("cancelled after write")
    expect(op.api.writes).toEqual(["createComment"])
    expect(op.review.commentIntent).toBe(true)
    op.api.onWrite = undefined
    await op.run()
    expect(op.api.rest.issues.createComment).toHaveBeenCalledTimes(1)
    expect(op.review.state).toBe("complete")
  })
})
