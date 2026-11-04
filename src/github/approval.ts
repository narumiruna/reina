import type { Actor, Approval, Issue, LabelEvent, Proposal } from "../types.js"
import { proposalBody } from "./publisher.js"
import { type GitHub, GitHubError, numericId, sameRepository } from "./scanner.js"

function requireCurrent(github: GitHub, issue: Issue, proposal: Proposal, now: number): void {
  if (
    !sameRepository(github.repository, issue.ref) ||
    !sameRepository(issue.ref, proposal.ref) ||
    issue.ref.issueId !== proposal.ref.issueId ||
    issue.ref.number !== proposal.ref.number
  ) {
    throw new GitHubError("approval_repository_mismatch")
  }
  if (
    issue.pullRequest ||
    issue.state !== "open" ||
    issue.labels.includes("bot:skip") ||
    !issue.labels.includes("fix_available") ||
    !issue.labels.includes("bot:approved")
  ) {
    throw new GitHubError("approval_issue_not_eligible")
  }
  if (
    !Number.isSafeInteger(proposal.commentId) ||
    (proposal.commentId ?? 0) < 1 ||
    !Number.isFinite(proposal.createdAt) ||
    !Number.isFinite(proposal.publishedAt) ||
    !Number.isFinite(proposal.expiresAt) ||
    !Number.isFinite(now) ||
    proposal.createdAt > (proposal.publishedAt ?? 0) ||
    (proposal.publishedAt ?? 0) > now ||
    now >= Math.min(proposal.expiresAt, proposal.createdAt + 24 * 60 * 60_000)
  ) {
    throw new GitHubError("approval_proposal_not_current")
  }
}

async function currentEvent(
  github: GitHub,
  issue: Issue,
  proposal: Proposal,
  now: number,
): Promise<{ event: LabelEvent; permission: string }> {
  requireCurrent(github, issue, proposal, now)
  const comments = await github.comments(issue.ref.number)
  const comment = comments.find((item) => numericId(item.id) === proposal.commentId)
  if (
    !comment ||
    comment.user?.id !== github.botId ||
    comment.user.type !== "Bot" ||
    comment.body !== proposalBody(proposal) ||
    Date.parse(comment.created_at) !== proposal.publishedAt
  ) {
    throw new GitHubError("approval_proposal_comment_changed")
  }
  const history = await github.history(issue.ref.number)
  if (
    history.some(
      (item) =>
        (item.event === "closed" || item.event === "reopened") &&
        item.createdAt >= proposal.createdAt,
    )
  ) {
    throw new GitHubError("approval_issue_lifecycle_changed")
  }
  const transitions = history
    .filter((event) => event.label === "bot:approved")
    .sort((a, b) => a.createdAt - b.createdAt)
  const event = transitions.at(-1)
  if (
    event?.event !== "labeled" ||
    event.createdAt <= (proposal.publishedAt ?? 0) ||
    event.createdAt > now ||
    event.actor.type !== "User" ||
    event.actor.id === github.botId ||
    !Number.isSafeInteger(event.actor.id) ||
    event.actor.id < 1 ||
    transitions.some((other) => other.id !== event.id && other.createdAt === event.createdAt)
  ) {
    throw new GitHubError("approval_history_not_current")
  }
  // An exclusion or loss of the proposal label revokes this transition even if
  // those labels were subsequently restored. A new approval is required.
  if (
    history.some(
      (other) =>
        other.createdAt >= event.createdAt &&
        ((other.label === "bot:skip" && other.event === "labeled") ||
          (other.label === "fix_available" && other.event === "unlabeled")),
    )
  ) {
    throw new GitHubError("approval_revoked")
  }
  const permission = await github.permission(event.actor.login, event.actor.id)
  if (!["write", "maintain", "admin"].includes(permission)) {
    throw new GitHubError("approval_permission_denied")
  }
  return { event, permission }
}

/** The coordinator supplies the live issue and checks its fingerprint and policy. */
export async function authorize(
  github: GitHub,
  issue: Issue,
  proposal: Proposal,
  actor?: Actor,
  now = Date.now(),
): Promise<Approval> {
  const { event, permission } = await currentEvent(github, issue, proposal, now)
  if (
    actor &&
    (actor.type !== "User" ||
      actor.id !== event.actor.id ||
      actor.login.toLowerCase() !== event.actor.login.toLowerCase())
  ) {
    throw new GitHubError("approval_actor_mismatch")
  }
  if (await github.conflicts(issue.ref.number)) throw new GitHubError("approval_conflicting_work")
  return {
    eventId: event.id,
    actor: event.actor,
    proposalRevision: proposal.revision,
    createdAt: event.createdAt,
    permission,
  }
}

/** Recheck authority, but do not reject the job's own publication branch. */
export async function revalidate(
  github: GitHub,
  issue: Issue,
  proposal: Proposal,
  approval: Approval,
): Promise<void> {
  const { event } = await currentEvent(github, issue, proposal, Date.now())
  if (
    approval.proposalRevision !== proposal.revision ||
    approval.eventId !== event.id ||
    approval.createdAt !== event.createdAt ||
    approval.actor.id !== event.actor.id ||
    approval.actor.type !== "User" ||
    approval.actor.login.toLowerCase() !== event.actor.login.toLowerCase()
  ) {
    throw new GitHubError("approval_event_replaced")
  }
}
