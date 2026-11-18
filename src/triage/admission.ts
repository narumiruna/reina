import type { IssueRef } from "../types.js"
import type { ReviewBinding } from "./review.js"

/** One authorized human request, pinned before trigger cleanup or inference. */
export interface TriageAdmission {
  /** Stable namespaced event identity, at most 200 ASCII characters. */
  source: string
  ref: IssueRef
  binding: ReviewBinding
  /** Authoritative human event timestamp, not delivery receipt time. */
  createdAt: number
  /** Lowercase SHA-256 digest of a signed label candidate; absent for direct fixes. */
  candidateKey?: string
}

export interface TriageAdmissionRecord extends TriageAdmission {
  status: "pending" | "claimed" | "revoked"
  /** Exact review revision that spent the grant; absent on older records. */
  claimRevision?: string
  /** One-use permission for trigger removal; survives uncertain writes/restart. */
  cleanupIntent: boolean
}
