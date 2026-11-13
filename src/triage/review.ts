import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { IssueRef } from "../types.js"
import { type Assessment, assessmentSchema, type TriageOutcome } from "./assessment.js"

export type ReviewState = "pending" | "running" | "assessed" | "complete" | "stale" | "failed"

export interface ReviewBinding {
  fingerprint: string
  baseBranch: string
  baseSha: string
  policyHash: string
  protocolRevision: string
}

export interface Review {
  ref: IssueRef
  revision: string
  binding: ReviewBinding
  state: ReviewState
  attempts: number
  createdAt: number
  updatedAt: number
  nextAttemptAt: number
  assessment?: Assessment
  outcome?: TriageOutcome
  assessedAt?: number
  error?: string
  inactiveReason?: "changed" | "closed" | "skipped" | "unavailable"
  commentId?: number
  commentIntent?: boolean
  commentRetryAt?: number
  publishedRevision?: string
}

// Reserve 4 KiB of the 64 KiB record for mutable lifecycle metadata.
export const REVIEW_RESULT_LIMIT = 60 * 1024
export const REVIEW_RETRY_DELAYS = [60_000, 300_000] as const

/** Measure the same immutable assessment representation before and after publication. */
export function reviewResultBytes(review: Review): number {
  const { ref, revision, binding, createdAt, assessment, outcome, assessedAt } = review
  return Buffer.byteLength(
    JSON.stringify({ ref, revision, binding, createdAt, assessment, outcome, assessedAt }),
  )
}

export interface ReviewInvalidation {
  ref: IssueRef
  reason: NonNullable<Review["inactiveReason"]>
}

/** Preserve evidence and budget while revoking a revision's publication claim. */
export function staleReview(
  review: Review,
  reason: ReviewInvalidation["reason"],
  now = Date.now(),
): Review {
  if (
    review.state === "stale" &&
    review.inactiveReason === reason &&
    reviewResultBytes(review) <= REVIEW_RESULT_LIMIT
  )
    return review
  const { publishedRevision: _published, ...previous } = review
  const invalidated: Review = {
    ...previous,
    revision: randomUUID(),
    state: "stale",
    inactiveReason: reason,
    ...(review.state === "running"
      ? {
          error: "triage_interrupted",
          nextAttemptAt: now + (REVIEW_RETRY_DELAYS[review.attempts - 1] ?? 0),
        }
      : {}),
    updatedAt: Math.max(now, review.updatedAt),
  }
  if (reviewResultBytes(invalidated) > REVIEW_RESULT_LIMIT) {
    delete invalidated.assessment
    delete invalidated.outcome
    delete invalidated.assessedAt
    invalidated.error = "triage_invalid_output"
    invalidated.nextAttemptAt = 0
  }
  return invalidated
}

export const REVIEW_LABELS = [
  "bot:triaged",
  "bot:needs-info",
  "bot:needs-human",
  "bot:triage-failed",
] as const

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !/[\p{Cc}]/u.test(value))

const reviewRecordSchema = z
  .strictObject({
    ref: z.strictObject({
      owner: text(39),
      name: text(100),
      id: positiveId,
      installationId: positiveId,
      number: positiveId,
      issueId: positiveId,
    }),
    revision: z.uuid(),
    binding: z.strictObject({
      fingerprint: digest,
      baseBranch: text(255),
      baseSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i),
      policyHash: digest,
      protocolRevision: text(100),
    }),
    state: z.enum(["pending", "running", "assessed", "complete", "stale", "failed"]),
    attempts: z.number().int().min(0).max(3),
    createdAt: timestamp,
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
    assessment: assessmentSchema.optional(),
    outcome: z.enum(["fix_candidate", "needs_info", "needs_human"]).optional(),
    assessedAt: timestamp.optional(),
    error: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/)
      .optional(),
    inactiveReason: z.enum(["changed", "closed", "skipped", "unavailable"]).optional(),
    commentId: positiveId.optional(),
    commentIntent: z.boolean().optional(),
    commentRetryAt: timestamp.optional(),
    publishedRevision: z.uuid().optional(),
  })
  .refine((review) => {
    const evidence = [review.assessment, review.outcome, review.assessedAt]
    const hasResult = evidence.every((value) => value !== undefined)
    const noResult = evidence.every((value) => value === undefined)
    const successful = review.state === "assessed" || review.state === "complete"
    return (
      Buffer.byteLength(JSON.stringify(review)) <= 65_536 &&
      review.updatedAt >= review.createdAt &&
      (review.assessedAt === undefined || review.assessedAt <= review.updatedAt) &&
      (hasResult || noResult) &&
      (successful
        ? hasResult && review.attempts >= 1 && review.error === undefined
        : review.state === "stale" || noResult) &&
      (review.state !== "running" || review.attempts >= 1) &&
      (review.state !== "pending" || review.attempts < 3) &&
      (review.inactiveReason === undefined || review.state === "stale") &&
      (review.commentRetryAt === undefined || review.commentIntent === true) &&
      (review.state !== "complete" ||
        (review.publishedRevision === review.revision && review.commentId !== undefined))
    )
  })

export const reviewSchema: z.ZodType<Review> = z.preprocess((value, context) => {
  try {
    const json = JSON.stringify(value)
    if (json !== undefined && Buffer.byteLength(json) <= 65_536) return value
  } catch {
    // Circular values and non-JSON values cannot be persisted.
  }
  context.addIssue({ code: "custom", message: "Review exceeds JSON limits" })
  return z.NEVER
}, reviewRecordSchema)
