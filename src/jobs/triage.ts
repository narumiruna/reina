import { randomUUID } from "node:crypto"
import type { Publisher } from "../github/publisher.js"
import { type GitHub, GitHubIssueDeferred, sameRepository } from "../github/scanner.js"
import { reviewBody } from "../github/triage.js"
import { ASSESSMENT_PROTOCOL_REVISION, assessmentOutcome } from "../triage/assessment.js"
import { fingerprint, policyHash } from "../triage/policy.js"
import {
  REVIEW_RETRY_DELAYS as RETRY_DELAYS,
  REVIEW_RESULT_LIMIT,
  type Review,
  type ReviewBinding,
  reviewResultBytes,
  reviewSchema,
  staleReview,
} from "../triage/review.js"
import { triage } from "../triage/service.js"
import type { AgentRuntime, Config, Issue, IssueRef } from "../types.js"
import type { Store } from "./store.js"

const DAY = 86_400_000
const retryable = new Set(["runtime_timeout", "model_request_transient", "triage_interrupted"])
const safeFailures = new Set([
  ...retryable,
  "triage_invalid_issue",
  "triage_invalid_baseline",
  "triage_evidence_limit",
  "triage_invalid_output",
  "runtime_controls_unavailable",
  "runtime_preflight_required",
  "runtime_socket_unavailable",
  "docker_unavailable",
  "docker_operation_failed",
  "container_cleanup_failed",
  "pi_agent_error",
  "pi_incomplete",
  "pi_malformed_json",
  "pi_stdout_limit",
  "pi_stderr_limit",
  "pi_record_limit",
  "pi_exit_failure",
])

type Events = (event: string, ref: IssueRef, fields?: Record<string, unknown>) => void
type Head = { branch: string; sha: string }

export function reviewBinding(
  issue: Issue,
  head: Head,
  config: Config,
  botId: number,
): ReviewBinding {
  return {
    fingerprint: fingerprint(issue, botId),
    baseBranch: head.branch,
    baseSha: head.sha.toLowerCase(),
    policyHash: policyHash(config),
    protocolRevision: ASSESSMENT_PROTOCOL_REVISION,
  }
}

function sameBinding(a: ReviewBinding, b: ReviewBinding): boolean {
  return (
    a.fingerprint === b.fingerprint &&
    a.baseBranch === b.baseBranch &&
    a.baseSha === b.baseSha &&
    a.policyHash === b.policyHash &&
    a.protocolRevision === b.protocolRevision
  )
}

function updated(review: Review): number {
  return Math.max(Date.now(), review.updatedAt)
}

/** Durable read-only review lifecycle. It never creates proposals or grants approval. */
export class IssueTriage {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly runtime: AgentRuntime,
    private readonly botId: number,
    private readonly event: Events,
  ) {}

  private save(review: Review, expected?: string): Review {
    if (!this.store.saveReview(review, expected)) throw new Error("triage_stale")
    return review
  }

  invalidate(
    ref: IssueRef,
    reason: NonNullable<Review["inactiveReason"]> = "changed",
    correlationId?: string,
  ): Review | undefined {
    const current = this.store.review(ref)
    if (!current) return
    const invalidated = staleReview(current, reason)
    if (invalidated === current) return current
    const review = this.save(invalidated, current.revision)
    this.event("triage_stale", ref, {
      correlationId: correlationId ?? review.revision,
      revision: review.revision,
      reason,
    })
    return review
  }

  async project(
    review: Review,
    publisher: Publisher,
    signal: AbortSignal,
    correlationId = review.revision,
  ): Promise<Review> {
    signal.throwIfAborted()
    // Restored near-limit results must not deadlock publication or revocation.
    if (review.assessment && reviewResultBytes(review) > REVIEW_RESULT_LIMIT) {
      const {
        assessment: _assessment,
        outcome: _outcome,
        assessedAt: _at,
        publishedRevision: _published,
        inactiveReason: _inactive,
        ...metadata
      } = review
      review = this.save(
        {
          ...metadata,
          state: "failed",
          error: "triage_invalid_output",
          updatedAt: updated(review),
        },
        review.revision,
      )
      this.event("triage_failed", review.ref, {
        correlationId,
        revision: review.revision,
        reason: review.error,
      })
    }
    let expected = review.revision
    const save = (value: Review) => {
      signal.throwIfAborted()
      this.save(value, expected)
      expected = value.revision
    }
    const projected = await publisher.review(review, save, signal)
    signal.throwIfAborted()
    if (
      projected.state === "complete" &&
      (review.state !== "complete" || review.publishedRevision !== review.revision)
    ) {
      this.event("triage_completed", review.ref, {
        correlationId,
        revision: projected.revision,
        outcome: projected.outcome,
      })
    } else if (projected.state === "stale" && review.state !== "stale") {
      this.event("triage_stale", review.ref, {
        correlationId,
        revision: projected.revision,
        reason: projected.inactiveReason ?? "changed",
      })
    }
    return projected
  }

  async inactive(
    ref: IssueRef,
    reason: NonNullable<Review["inactiveReason"]>,
    publisher: Publisher,
    signal: AbortSignal,
    correlationId?: string,
  ): Promise<void> {
    const review = this.invalidate(ref, reason, correlationId)
    if (review) await this.project(review, publisher, signal, correlationId)
  }

  async run(
    issue: Issue,
    head: Head,
    github: GitHub,
    publisher: Publisher,
    signal: AbortSignal,
    correlationId: string,
  ): Promise<Review | undefined> {
    signal.throwIfAborted()
    if (issue.state !== "open" || issue.pullRequest || issue.labels.includes("bot:skip")) return
    const binding = reviewBinding(issue, head, this.config, this.botId)
    let review = this.store.review(issue.ref)
    const changed = review && !sameBinding(review.binding, binding)
    if (changed || review?.state === "stale") {
      review = this.invalidate(issue.ref, review?.inactiveReason ?? "changed", correlationId)
      if (review) review = await this.project(review, publisher, signal, correlationId)
    }
    signal.throwIfAborted()
    const renew =
      review?.outcome === "fix_candidate" &&
      review.assessment !== undefined &&
      review.assessedAt !== undefined &&
      (review.state === "stale" ||
        (review.state === "complete" && review.assessedAt + DAY <= Date.now()))
    if (!review || changed || renew) {
      const now = Date.now()
      const previous = review
      review = this.save(
        {
          ref: { ...issue.ref },
          revision: randomUUID(),
          binding,
          state: "pending",
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          nextAttemptAt: 0,
          ...(previous?.commentId === undefined ? {} : { commentId: previous.commentId }),
          ...(previous?.commentIntent === undefined
            ? {}
            : { commentIntent: previous.commentIntent }),
          ...(previous?.commentRetryAt === undefined
            ? {}
            : { commentRetryAt: previous.commentRetryAt }),
        },
        previous?.revision,
      )
    }
    if (review.state === "stale") {
      const {
        inactiveReason: _inactive,
        error,
        publishedRevision: _published,
        ...previous
      } = review
      review = this.save(
        {
          ...previous,
          state: review.assessment
            ? "assessed"
            : review.attempts >= 3 || (error && !retryable.has(error))
              ? "failed"
              : "pending",
          ...(review.assessment || error === undefined ? {} : { error }),
          updatedAt: updated(review),
        },
        review.revision,
      )
    }
    if (review.assessment && assessmentOutcome(review.assessment, this.config) !== review.outcome) {
      throw new Error("triage_result_mismatch")
    }
    if (["assessed", "complete", "failed"].includes(review.state)) {
      return this.project(review, publisher, signal, correlationId)
    }
    if (review.nextAttemptAt > Date.now()) {
      throw new GitHubIssueDeferred("triage_retry_pending", review.nextAttemptAt)
    }
    if (review.state === "running")
      throw new GitHubIssueDeferred("triage_busy", Date.now() + 60_000)
    if (review.attempts >= 3) throw new Error("triage_attempt_limit")
    const snapshot = await github.snapshotAt(head.branch, head.sha)
    signal.throwIfAborted()
    // Snapshot and stale-projection work can take time. Do not charge inference for
    // an issue closed/skipped or changed while those operations were in flight.
    const current = await github.issue(issue.ref.number)
    signal.throwIfAborted()
    if (!sameRepository(current.ref, issue.ref) || current.ref.issueId !== issue.ref.issueId)
      throw new Error("issue_identity_changed")
    if (current.state !== "open" || current.pullRequest || current.labels.includes("bot:skip")) {
      await this.inactive(
        issue.ref,
        current.state === "closed"
          ? "closed"
          : current.labels.includes("bot:skip")
            ? "skipped"
            : "unavailable",
        publisher,
        signal,
        correlationId,
      )
      return
    }
    const currentHead = await github.head()
    signal.throwIfAborted()
    if (!sameBinding(binding, reviewBinding(current, currentHead, this.config, this.botId))) {
      const stale = this.invalidate(issue.ref, "changed", correlationId)
      if (stale) await this.project(stale, publisher, signal, correlationId)
      return
    }
    review = this.save(
      {
        ...review,
        state: "running",
        attempts: review.attempts + 1,
        nextAttemptAt: 0,
        error: undefined,
        updatedAt: updated(review),
      },
      review.revision,
    )
    this.event("triage_started", issue.ref, {
      correlationId,
      revision: review.revision,
      attempt: review.attempts,
    })
    let assessed: Review
    try {
      const result = await triage(issue, snapshot, this.config, this.runtime, this.botId, signal)
      signal.throwIfAborted()
      const candidate = reviewSchema.safeParse({
        ...review,
        state: "assessed",
        assessment: result.assessment,
        outcome: result.outcome,
        assessedAt: Date.now(),
        updatedAt: updated(review),
        error: undefined,
      })
      if (!candidate.success || reviewResultBytes(candidate.data) > REVIEW_RESULT_LIMIT)
        throw new Error("triage_invalid_output")
      try {
        reviewBody(candidate.data)
      } catch {
        throw new Error("triage_invalid_output")
      }
      assessed = candidate.data
    } catch (error) {
      // Intake advances the revision before aborting work. Never overwrite its invalidation.
      if (this.store.review(issue.ref)?.revision !== review.revision) throw error
      if (signal.aborted) {
        const delay = RETRY_DELAYS[review.attempts - 1]
        this.save(
          {
            ...review,
            state: delay === undefined ? "failed" : "pending",
            nextAttemptAt: delay === undefined ? 0 : Date.now() + delay,
            error: "triage_interrupted",
            updatedAt: updated(review),
          },
          review.revision,
        )
        throw new Error("runtime_cancelled")
      }
      const code =
        error instanceof Error && safeFailures.has(error.message)
          ? error.message
          : "triage_assessment_failed"
      const delay = retryable.has(code) ? RETRY_DELAYS[review.attempts - 1] : undefined
      review = this.save(
        {
          ...review,
          state: delay === undefined ? "failed" : "pending",
          nextAttemptAt: delay === undefined ? 0 : Date.now() + delay,
          updatedAt: updated(review),
          error: code,
        },
        review.revision,
      )
      if (delay !== undefined) {
        throw new GitHubIssueDeferred("triage_retry_pending", review.nextAttemptAt)
      }
      this.event("triage_failed", issue.ref, {
        correlationId,
        revision: review.revision,
        reason: code,
      })
      return this.project(review, publisher, signal, correlationId)
    }
    // Storage/CAS failures are not model failures and must never consume a retry grant.
    review = this.save(assessed, review.revision)
    this.event("triage_decision", issue.ref, {
      correlationId,
      revision: review.revision,
      outcome: review.outcome,
      eligible: review.outcome === "fix_candidate",
    })
    return this.project(review, publisher, signal, correlationId)
  }
}
