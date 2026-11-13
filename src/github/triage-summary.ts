import type { IssueRef } from "../types.js"

const markerPrefix = "<!-- reina:triage:"
type SummaryRef = Pick<IssueRef, "id" | "issueId">

export function triageMarker(ref: SummaryRef): string {
  return `${markerPrefix}${ref.id}:${ref.issueId} -->`
}

/** Only one exact, bounded, bot-owned summary can receive a reader allowance. */
export function isOwnedTriageSummary(
  comment: { body?: string; user?: { id?: number | bigint; type?: string } | null },
  ref: SummaryRef,
  botId: number,
): boolean {
  return (
    comment.user?.id === botId &&
    comment.user.type === "Bot" &&
    typeof comment.body === "string" &&
    comment.body.startsWith(`${triageMarker(ref)}\n`) &&
    comment.body.split(markerPrefix).length === 2 &&
    !/<!-- reina:(?:proposal|job):/.test(comment.body) &&
    Buffer.byteLength(comment.body, "utf8") <= 64 * 1024
  )
}
