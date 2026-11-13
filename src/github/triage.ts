import { assessmentSchema } from "../triage/assessment.js"
import { fingerprint } from "../triage/policy.js"
import { REVIEW_LABELS, type Review, reviewSchema } from "../triage/review.js"
import {
  errorStatus,
  type GitHub,
  GitHubDeferred,
  GitHubError,
  GitHubOutcomeUnknown,
  GitHubWriteRejected,
  githubRead,
  githubWrite,
  numericId,
  sameRepository,
} from "./scanner.js"
import { isOwnedTriageSummary, triageMarker } from "./triage-summary.js"

const markerPrefix = "<!-- reina:triage:"
type Comment = Awaited<ReturnType<GitHub["comments"]>>[number]

/** Model text is data, not Markdown, a mention, a link, or a bot command. */
function data(value: string): string {
  return `<pre>${value
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? "\n" : " "))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[@#.:/\\]/g, (character) => `${character}\u200b`)}</pre>`
}

function body(review: Review): string {
  const parts = [triageMarker(review.ref), "## Issue triage"]
  if (review.state === "stale") {
    parts.push(
      review.inactiveReason === "changed"
        ? "This assessment is stale. The issue evidence or repository base changed."
        : "This assessment is inactive. It does not describe an active reviewed issue.",
    )
  } else if (review.state === "failed") {
    parts.push("Assessment failed. No valid current result is available.")
  }
  if (review.state !== "failed" && (review.state !== "stale" || review.assessment)) {
    if (review.state === "stale") parts.push("### Previous assessment (not current)")
    const assessment = assessmentSchema.parse(review.assessment)
    if (
      !["fix_candidate", "needs_info", "needs_human"].includes(review.outcome ?? "") ||
      !Number.isSafeInteger(review.assessedAt) ||
      (review.assessedAt ?? -1) < 0
    ) {
      throw new GitHubError("publication_invalid_review")
    }
    parts.push(
      `Kind: ${assessment.kind}`,
      data(assessment.summary),
      "### Missing information",
      "Do not publish credentials, security-sensitive information, or private diagnostic data.",
      ...(assessment.missingInfo.length ? assessment.missingInfo.map(data) : ["None recorded."]),
      "### Fix assessment",
      data(assessment.fix.reason),
      ...assessment.fix.risks.map(data),
      `Next action: ${review.outcome}`,
      `Assessed: ${new Date(review.assessedAt as number).toISOString()}.`,
    )
  }
  parts.push(
    "This is a read-only assessment. Triage did not modify code or verify a fix. " +
      "It does not grant approval to execute changes or establish that a fix is available.",
  )
  const result = parts.join("\n\n")
  if (Buffer.byteLength(result) > 64 * 1024) {
    if (review.state === "stale") {
      // Old or externally restored records can fit SQLite but exceed the escaped
      // publication limit. Invalidation must still clear their reviewed claim.
      return [
        triageMarker(review.ref),
        "## Issue triage",
        "This assessment is stale or inactive. Its previous details are omitted because they exceed publication limits.",
        "No current assessment, verified fix, or approval to execute changes is claimed.",
      ].join("\n\n")
    }
    throw new GitHubError("publication_body_limit")
  }
  return result
}

export { body as reviewBody }

/** Project a durable review. The caller checks policy and supplies a revision CAS. */
export async function publishReview(
  github: GitHub,
  input: Review,
  save: (review: Review) => void,
  signal?: AbortSignal,
): Promise<Review> {
  let review = structuredClone(input)
  const abort = () => signal?.throwIfAborted()
  const wait = async <T>(operation: () => Promise<T>): Promise<T> => {
    abort()
    try {
      return await operation()
    } finally {
      abort()
    }
  }
  const persist = () => {
    abort()
    review = { ...review, updatedAt: Math.max(Date.now(), review.updatedAt) }
    save(structuredClone(review))
    abort()
  }
  const write = async <T>(operation: () => Promise<T>): Promise<T> => {
    persist() // The revision CAS must still hold immediately before every remote write.
    return wait(() => githubWrite(operation))
  }
  if (
    !sameRepository(github.repository, review.ref) ||
    !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(review.revision)
  ) {
    throw new GitHubError("publication_review_mismatch")
  }
  numericId(review.ref.number)
  numericId(review.ref.issueId)
  reviewSchema.parse(review)
  abort()
  if (review.state === "pending" || review.state === "running") return review
  // Validate the result before any mutation, including removal of an old label.
  body(review)

  const issue = async () => {
    await wait(() => github.check())
    const { data: current } = await wait(() =>
      githubRead(() =>
        github.client.rest.issues.get({
          ...github.coordinates,
          issue_number: review.ref.number,
        }),
      ),
    )
    if (numericId(current.id) !== review.ref.issueId || current.number !== review.ref.number) {
      throw new GitHubError("publication_issue_mismatch")
    }
    return current
  }
  const currentBinding = async (): Promise<Review["inactiveReason"] | undefined> => {
    const current = await issue()
    if (current.pull_request) throw new GitHubError("publication_issue_not_eligible")
    if (current.state !== "open") return "closed"
    if (
      current.labels.some(
        (label) => (typeof label === "string" ? label : label.name) === "bot:skip",
      )
    )
      return "skipped"
    if (review.state === "stale" || review.state === "failed") return undefined
    const evidence = await wait(() => github.issue(review.ref.number))
    if (evidence.ref.issueId !== review.ref.issueId || !sameRepository(evidence.ref, review.ref)) {
      throw new GitHubError("publication_issue_mismatch")
    }
    if (evidence.pullRequest) throw new GitHubError("publication_issue_not_eligible")
    if (evidence.state !== "open") return "closed"
    if (evidence.labels.includes("bot:skip")) return "skipped"
    const head = await wait(() => github.head())
    if (
      fingerprint(evidence, github.botId) !== review.binding.fingerprint ||
      head.branch !== review.binding.baseBranch ||
      head.sha !== review.binding.baseSha
    )
      return "changed"
    return undefined
  }
  const invalidate = (reason: NonNullable<Review["inactiveReason"]>) => {
    review = { ...review, state: "stale", inactiveReason: reason }
    delete review.publishedRevision
    persist()
  }
  const reason = await currentBinding()
  if (reason) invalidate(reason)

  const validateComment = (comment: Comment) => {
    if (!isOwnedTriageSummary(comment, review.ref, github.botId))
      throw new GitHubError("publication_comment_conflict")
    numericId(comment.id)
    return comment
  }
  const reconcile = async (): Promise<Comment | undefined> => {
    const comments = await wait(() => github.comments(review.ref.number))
    const matches = comments.filter(
      (comment) =>
        comment.user?.id === github.botId &&
        comment.user.type === "Bot" &&
        comment.body?.includes(markerPrefix),
    )
    if (matches.length > 1) throw new GitHubError("publication_comment_conflict")
    const found = matches[0] ? validateComment(matches[0]) : undefined
    if (review.commentId !== undefined && found?.id !== review.commentId) {
      // A list alone can temporarily omit a comment. Require a scoped 404 as well.
      try {
        await wait(() =>
          githubRead(() =>
            github.client.rest.issues.getComment({
              ...github.coordinates,
              comment_id: numericId(review.commentId as number),
            }),
          ),
        )
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 404) throw error
        if (found) throw new GitHubError("publication_comment_conflict")
        if (review.state === "complete") review = { ...review, state: "assessed" }
        delete review.publishedRevision
        delete review.commentId
        delete review.commentIntent
        delete review.commentRetryAt
        persist()
        return undefined
      }
      throw new GitHubError("publication_comment_conflict")
    }
    if (found && review.commentId === undefined) {
      review.commentId = numericId(found.id)
      review.commentIntent = true
      delete review.commentRetryAt
      persist()
    }
    return found
  }
  const labels = async () => {
    const current = await issue()
    return new Set(current.labels.map((label) => (typeof label === "string" ? label : label.name)))
  }
  const projectLabels = async (desired: readonly string[]) => {
    const current = await labels()
    for (const name of REVIEW_LABELS) {
      if (!current.has(name) || desired.includes(name)) continue
      persist()
      try {
        await wait(() =>
          githubWrite(() =>
            github.client.rest.issues.removeLabel({
              ...github.coordinates,
              issue_number: review.ref.number,
              name,
            }),
          ),
        )
      } catch (error) {
        if (errorStatus(error) !== 404) throw error
      }
    }
    const missing = desired.filter((name) => !current.has(name))
    for (const name of missing) {
      const { data: definition } = await wait(() =>
        githubRead(() => github.client.rest.issues.getLabel({ ...github.coordinates, name })),
      )
      if (definition.name !== name) throw new GitHubError("publication_label_mismatch")
    }
    if (missing.length)
      await write(() =>
        github.client.rest.issues.addLabels({
          ...github.coordinates,
          issue_number: review.ref.number,
          labels: [...missing],
        }),
      )
  }
  const desiredOutcome = () =>
    review.state === "stale"
      ? []
      : review.state === "failed"
        ? ["bot:triage-failed"]
        : review.outcome === "needs_info"
          ? ["bot:needs-info"]
          : review.outcome === "needs_human"
            ? ["bot:needs-human"]
            : []

  // A confirmed conflict revokes only the reviewed claim, not the assessment or
  // delivery identity. Keep all other labels unchanged during conflict cleanup.
  const removeReviewedClaim = async () => {
    if (review.state === "complete") review = { ...review, state: "assessed" }
    delete review.publishedRevision
    persist()
    const current = await labels()
    if (!current.has("bot:triaged")) return
    // Keep the CAS outside the 404 handler: a rejected save is not a missing label.
    persist()
    try {
      await wait(() =>
        githubWrite(() =>
          github.client.rest.issues.removeLabel({
            ...github.coordinates,
            issue_number: review.ref.number,
            name: "bot:triaged",
          }),
        ),
      )
    } catch (error) {
      if (errorStatus(error) !== 404) throw error
    }
  }

  try {
    let labelsCleared = false
    if (review.state !== "complete") {
      delete review.publishedRevision
      persist()
      await projectLabels([])
      labelsCleared = true
    }
    let comment = await reconcile()
    let expected = body(review)
    if (
      review.state === "complete" &&
      review.publishedRevision === review.revision &&
      comment?.body === expected
    ) {
      const desired = [...desiredOutcome(), "bot:triaged"]
      const current = await labels()
      if (REVIEW_LABELS.every((name) => current.has(name) === desired.includes(name))) {
        const changed = await currentBinding()
        if (changed) {
          invalidate(changed)
          expected = body(review)
        } else {
          const latest = await reconcile()
          if (latest?.id !== comment.id || latest.body !== expected)
            throw new GitHubError("publication_comment_conflict")
          persist()
          return review
        }
      }
    }
    if (!labelsCleared) {
      if (review.state === "complete") review = { ...review, state: "assessed" }
      delete review.publishedRevision
      persist()
      // Remove any reviewed claim before changing the mutable summary.
      await projectLabels([])
    }
    if (!comment && review.state !== "stale" && review.state !== "failed") {
      const retryAt = review.commentIntent ? review.commentRetryAt : undefined
      if (review.commentIntent && retryAt === undefined)
        throw new GitHubOutcomeUnknown("github_comment_outcome_unknown")
      if (retryAt !== undefined && retryAt > Date.now()) throw new GitHubWriteRejected(retryAt)
      review.commentIntent = true
      delete review.commentRetryAt // Consume the one-use rejection grant before POST.
      persist() // A failed CAS must not be caught as an ambiguous remote write.
      try {
        const response = await wait(() =>
          githubWrite(() =>
            github.client.rest.issues.createComment({
              ...github.coordinates,
              issue_number: review.ref.number,
              body: expected,
            }),
          ),
        )
        comment = response.data
      } catch (error) {
        if (error instanceof GitHubWriteRejected) {
          review.commentRetryAt = error.retryAt
          persist()
        }
        if (error instanceof GitHubDeferred || signal?.aborted) throw error
        comment = await reconcile()
        if (!comment) throw new GitHubOutcomeUnknown("github_comment_outcome_unknown")
      }
    }
    if (comment) {
      validateComment(comment)
      review.commentId = numericId(comment.id)
      review.commentIntent = true
      delete review.commentRetryAt
      persist() // Keep confirmed identity even if the update or labels fail.
      if (comment.body !== expected) {
        const { data: updated } = await write(() =>
          github.client.rest.issues.updateComment({
            ...github.coordinates,
            comment_id: comment.id,
            body: expected,
          }),
        )
        validateComment(updated)
        if (updated.id !== comment.id || updated.body !== expected)
          throw new GitHubError("publication_comment_conflict")
      }
    }

    if (review.state !== "stale" && review.state !== "failed") {
      const changed = await currentBinding()
      if (changed) {
        invalidate(changed)
        expected = body(review)
        await projectLabels([])
        if (comment) {
          const { data: updated } = await write(() =>
            github.client.rest.issues.updateComment({
              ...github.coordinates,
              comment_id: comment.id,
              body: expected,
            }),
          )
          validateComment(updated)
          if (updated.id !== comment.id || updated.body !== expected)
            throw new GitHubError("publication_comment_conflict")
        }
      }
    }
    const confirmed = await reconcile()
    if ((comment && confirmed?.body !== expected) || (!comment && confirmed))
      throw new GitHubError("publication_comment_conflict")
    const desired = desiredOutcome()
    await projectLabels(desired)
    if (review.state !== "stale" && review.state !== "failed") {
      // Recheck the complete evidence and base immediately before the reviewed label.
      const changed = await currentBinding()
      if (changed) {
        invalidate(changed)
        return publishReview(github, review, save, signal)
      }
      if (!confirmed || confirmed.id !== review.commentId)
        throw new GitHubError("publication_comment_conflict")
      const current = await labels()
      if (REVIEW_LABELS.some((name) => current.has(name) !== desired.includes(name)))
        throw new GitHubError("publication_labels_unconfirmed")
      const latest = await reconcile()
      if (latest?.id !== confirmed.id || latest?.body !== expected)
        throw new GitHubError("publication_comment_conflict")
      await projectLabels([...desired, "bot:triaged"])
      desired.push("bot:triaged")
    }
    const projected = await labels()
    if (REVIEW_LABELS.some((name) => projected.has(name) !== desired.includes(name)))
      throw new GitHubError("publication_labels_unconfirmed")
    const finalComment = await reconcile()
    if (
      (comment && (finalComment?.id !== comment.id || finalComment?.body !== expected)) ||
      (!comment && finalComment)
    )
      throw new GitHubError("publication_comment_conflict")
    if (review.state !== "stale" && review.state !== "failed") {
      const changed = await currentBinding()
      if (changed) {
        invalidate(changed)
        return publishReview(github, review, save, signal)
      }
    }
    review = {
      ...review,
      state: review.state === "assessed" ? "complete" : review.state,
      publishedRevision: review.revision,
    }
    persist()
    return review
  } catch (error) {
    if (error instanceof GitHubError && error.code === "publication_comment_conflict") {
      // Save revocation before cleanup can fail or establish a global cooldown.
      await removeReviewedClaim()
    }
    throw error
  }
}
