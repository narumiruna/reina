import { randomUUID } from "node:crypto"
import type { Publisher } from "../github/publisher.js"
import {
  type GitHub,
  GitHubDeferred,
  GitHubIssueDeferred,
  sameRepository,
} from "../github/scanner.js"
import { reviewBody } from "../github/triage.js"
import { ASSESSMENT_PROTOCOL_REVISION, assessmentOutcome } from "../triage/assessment.js"
import { fingerprint, policyHash } from "../triage/policy.js"
import {
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
const safeFailures = new Set([
  "runtime_timeout",
  "model_request_transient",
  "triage_interrupted",
  "triage_invalid_issue",
  "triage_invalid_baseline",
  "triage_evidence_limit",
  "triage_invalid_output",
  "runtime_controls_unavailable",
  "runtime_preflight_required",
  "worker_dependency_fingerprint_mismatch",
  "worker_image_not_prepared",
  "worker_pi_version_mismatch",
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

export interface TriageAuthority {
  source: string
  force: boolean
  validate: () => Promise<unknown>
}

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

export function sameBinding(a: ReviewBinding, b: ReviewBinding): boolean {
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
    explicit?: TriageAuthority,
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
    // A transient metadata read does not erase a validated result. Restore only
    // the unchanged saved projection, never model authority or assessment time.
    if (
      !changed &&
      review?.state === "stale" &&
      review.assessment &&
      review.inactiveReason === "unavailable" &&
      review.evidenceError === "triage_evidence_unavailable"
    ) {
      const { inactiveReason: _inactive, evidenceError: _evidence, ...saved } = review
      review = this.save(
        { ...saved, state: "assessed", updatedAt: updated(review) },
        review.revision,
      )
    }
    const admission = explicit ? this.store.triageAdmission(explicit.source) : undefined
    if (admission && !sameBinding(admission.binding, binding)) {
      this.store.revokeTriage(admission.source)
      return review
    }
    if (
      !changed &&
      review?.assessment &&
      assessmentOutcome(review.assessment, this.config) !== review.outcome
    )
      throw new Error("triage_result_mismatch")
    const reusable =
      review?.assessment !== undefined &&
      (review.state === "assessed" || review.state === "complete") &&
      !changed &&
      (review.outcome !== "fix_candidate" ||
        (review.assessedAt !== undefined && review.assessedAt + DAY > Date.now()))
    const initial =
      !explicit &&
      this.store.automaticTriageAllowed(issue.ref, issue.createdAt) &&
      (!review || (review.attempts === 0 && !review.assessment && !review.error))
    const admitted = admission?.status === "pending" && (explicit?.force || !reusable)
    if (!initial && !admitted) {
      return review ? this.project(review, publisher, signal, correlationId) : undefined
    }
    if (!review || changed || review.state !== "pending" || review.attempts !== 0) {
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
    if (explicit) {
      try {
        await explicit.validate()
        signal.throwIfAborted()
      } catch (error) {
        if (!(error instanceof GitHubDeferred) && !(error instanceof GitHubIssueDeferred))
          this.store.revokeTriage(explicit.source)
        throw error
      }
    }
    const claimed = this.store.claimTriage(review, explicit?.source, issue.createdAt)
    if (!claimed) throw new Error("triage_stale")
    review = claimed
    this.event("triage_started", issue.ref, {
      correlationId,
      revision: review.revision,
      attempt: review.attempts,
      source: explicit?.source ?? "initial",
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
        this.save(
          {
            ...review,
            state: "failed",
            nextAttemptAt: 0,
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
      review = this.save(
        {
          ...review,
          state: "failed",
          nextAttemptAt: 0,
          updatedAt: updated(review),
          error: code,
        },
        review.revision,
      )
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
