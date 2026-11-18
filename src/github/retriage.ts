import { createHash } from "node:crypto"
import type { Actor, Issue, IssueRef, LabelEvent, RetriageRequest } from "../types.js"
import { type GitHub, GitHubError, numericId, sameRepository } from "./scanner.js"

/** Signed intake identity, not evidence that a label transition occurred. */
export interface RetriageCandidate {
  candidateKey: string
  createdAt: number
}

/** The one-shot human trigger is not a review projection or an approval. */
export const RETRIAGE_LABEL = "bot:retriage"

function requireRef(ref: IssueRef): void {
  for (const id of [ref.installationId, ref.id, ref.issueId, ref.number]) {
    if (typeof id !== "number") throw new GitHubError("retriage_repository_mismatch")
    numericId(id)
  }
}

function requireActor(github: GitHub, actor: Actor): void {
  if (typeof actor.id !== "number") throw new GitHubError("retriage_actor_mismatch")
  numericId(actor.id)
  if (
    actor.type !== "User" ||
    actor.id === github.botId ||
    typeof actor.login !== "string" ||
    !/^[a-z\d-]+$/i.test(actor.login) ||
    actor.login.toLowerCase() === github.botLogin?.toLowerCase()
  ) {
    throw new GitHubError("retriage_actor_mismatch")
  }
}

function requireTime(createdAt: number, now: number): void {
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !Number.isFinite(now) ||
    createdAt > now ||
    createdAt + 86_400_000 <= now
  ) {
    throw new GitHubError("retriage_request_not_current")
  }
}

/** Hashes normalized pinned event identity without delivery IDs or private text. */
export function retriageCandidateKey(
  ref: IssueRef,
  actor: Actor,
  createdAt: number,
  contentHash: string,
): string {
  requireRef(ref)
  if (typeof actor.id !== "number") throw new GitHubError("retriage_actor_mismatch")
  numericId(actor.id)
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !/^[a-f\d]{64}$/.test(contentHash))
    throw new GitHubError("retriage_candidate_mismatch")
  return createHash("sha256")
    .update(
      JSON.stringify([
        "retriage",
        ref.installationId,
        ref.id,
        ref.issueId,
        ref.number,
        actor.id,
        RETRIAGE_LABEL,
        createdAt,
        contentHash,
      ]),
    )
    .digest("hex")
}

function sourceFor(ref: IssueRef, event: LabelEvent): string {
  return `retriage:${ref.installationId}:${ref.id}:${ref.issueId}:${ref.number}:${event.id}`
}

function sameActor(a: Actor, b: Actor): boolean {
  return a.id === b.id && a.login === b.login && a.type === b.type
}

function botCleanup(github: GitHub, event: LabelEvent): boolean {
  return (
    event.event === "unlabeled" &&
    event.actor.id === github.botId &&
    event.actor.type === "Bot" &&
    (github.botLogin === undefined || event.actor.login === github.botLogin)
  )
}

function requireHistory(history: LabelEvent[], now: number): void {
  const ids = new Set<string>()
  let previousTime = 0
  for (const event of history) {
    if (
      !/^[1-9]\d*$/.test(event.id) ||
      !Number.isSafeInteger(Number(event.id)) ||
      ids.has(event.id) ||
      !Number.isSafeInteger(event.createdAt) ||
      event.createdAt < previousTime ||
      event.createdAt > now ||
      !event.actor?.login ||
      !event.actor.type
    ) {
      throw new GitHubError("retriage_ambiguous_history")
    }
    numericId(event.actor.id)
    ids.add(event.id)
    previousTime = event.createdAt
  }
}

function currentTransition(
  github: GitHub,
  issue: Issue,
  candidate: RetriageCandidate,
  actor: Actor,
  history: LabelEvent[],
  admittedSource?: string,
): LabelEvent {
  const transitions = history.filter(
    (event) => event.label === RETRIAGE_LABEL && ["labeled", "unlabeled"].includes(event.event),
  )
  // A resumption must find its original event, never the latest replacement.
  const event =
    admittedSource !== undefined
      ? transitions.find((item) => sourceFor(issue.ref, item) === admittedSource)
      : transitions.at(-1)
  if (
    event?.event !== "labeled" ||
    event.createdAt !== candidate.createdAt ||
    !sameActor(event.actor, actor)
  ) {
    // updated_at is only a correlation bound. A timestamp mismatch denies the
    // candidate instead of assuming GitHub ties it to a particular transition.
    throw new GitHubError("retriage_transition_not_current")
  }
  const later = transitions.slice(transitions.indexOf(event) + 1)
  const cleaned = later.length === 1 && botCleanup(github, later[0])
  // GitHub timestamps have one-second precision. A uniquely observed bot cleanup
  // after admission is expected even in that same second; human transitions
  // sharing the timestamp remain ambiguous and cannot authorize inference.
  if (
    transitions.some(
      (other) =>
        other.id !== event.id &&
        other.createdAt === event.createdAt &&
        !(admittedSource && cleaned && other.id === later[0].id),
    )
  )
    throw new GitHubError("retriage_transition_not_current")
  if (
    (later.length !== 0 && (!admittedSource || !cleaned)) ||
    issue.labels.includes(RETRIAGE_LABEL) !== (later.length === 0)
  ) {
    throw new GitHubError("retriage_transition_replaced")
  }
  if (
    history.some(
      (other) =>
        other.createdAt >= event.createdAt &&
        (other.event === "closed" || other.event === "reopened" || other.label === "bot:skip"),
    )
  ) {
    throw new GitHubError("retriage_revoked")
  }
  return event
}

async function currentIssue(github: GitHub, issue: Issue): Promise<Issue> {
  requireRef(issue.ref)
  if (!sameRepository(github.repository, issue.ref))
    throw new GitHubError("retriage_repository_mismatch")
  if (issue.state !== "open" || issue.pullRequest || issue.labels.includes("bot:skip"))
    throw new GitHubError("retriage_issue_not_eligible")
  const live = await github.issue(issue.ref.number).catch((error: unknown) => {
    if (error instanceof GitHubError && error.status === 404)
      throw new GitHubError("retriage_issue_not_eligible")
    throw error
  })
  requireRef(live.ref)
  if (
    !sameRepository(issue.ref, live.ref) ||
    live.ref.issueId !== issue.ref.issueId ||
    live.ref.number !== issue.ref.number
  ) {
    throw new GitHubError("retriage_repository_mismatch")
  }
  if (live.state !== "open" || live.pullRequest || live.labels.includes("bot:skip"))
    throw new GitHubError("retriage_issue_not_eligible")
  const comments = (value: Issue) =>
    value.comments
      .filter((comment) => comment.authorId !== github.botId)
      .map(({ id, authorId, body }) => [id, authorId, body])
  if (
    live.title !== issue.title ||
    live.body !== issue.body ||
    live.createdAt !== issue.createdAt ||
    JSON.stringify(comments(live)) !== JSON.stringify(comments(issue))
  ) {
    throw new GitHubError("retriage_issue_changed")
  }
  return live
}

async function currentComments(
  github: GitHub,
  issue: Issue,
  createdAt: number,
  now: number,
): Promise<void> {
  const comments = await github.comments(issue.ref.number)
  for (const comment of comments) {
    const authorId = numericId(comment.user?.id ?? 0)
    if (authorId === github.botId) continue
    const created = Date.parse(comment.created_at)
    const updated = Date.parse(comment.updated_at)
    if (
      !Number.isSafeInteger(created) ||
      created < 0 ||
      !Number.isSafeInteger(updated) ||
      updated < created ||
      updated > now ||
      created >= createdAt ||
      (updated > created && updated >= createdAt)
    ) {
      throw new GitHubError("retriage_issue_changed")
    }
    const observed = issue.comments.find((item) => item.id === numericId(comment.id))
    if (!observed || observed.authorId !== authorId || observed.body !== (comment.body ?? ""))
      throw new GitHubError("retriage_issue_changed")
  }
  if (
    comments.filter((comment) => numericId(comment.user?.id ?? 0) !== github.botId).length !==
    issue.comments.filter((comment) => comment.authorId !== github.botId).length
  ) {
    throw new GitHubError("retriage_issue_changed")
  }
}

async function humanPermission(github: GitHub, actor: Actor): Promise<void> {
  const permission = await github.permission(actor.login, actor.id).catch((error: unknown) => {
    if (error instanceof GitHubError) {
      if (["github_permission_mismatch", "github_invalid_actor"].includes(error.code))
        throw new GitHubError("retriage_actor_mismatch")
      if (error.status === 403 || error.status === 404)
        throw new GitHubError("retriage_permission_denied")
    }
    throw error
  })
  if (!["write", "maintain", "admin"].includes(permission))
    throw new GitHubError("retriage_permission_denied")
}

async function inspectCurrent(
  github: GitHub,
  issue: Issue,
  candidate: RetriageCandidate,
  actor: Actor,
  admittedSource: string | undefined,
  now: number,
): Promise<{ request: RetriageRequest; issue: Issue; present: boolean }> {
  requireActor(github, actor)
  requireTime(candidate.createdAt, now)
  const live = await currentIssue(github, issue)
  const contentHash = createHash("sha256")
    .update(JSON.stringify([live.title, live.body]))
    .digest("hex")
  const expectedKey = retriageCandidateKey(live.ref, actor, candidate.createdAt, contentHash)
  if (candidate.candidateKey !== expectedKey) {
    throw new GitHubError("retriage_candidate_mismatch")
  }
  if (
    live.createdAt !== undefined &&
    (!Number.isSafeInteger(live.createdAt) ||
      live.createdAt < 0 ||
      live.createdAt > candidate.createdAt)
  ) {
    throw new GitHubError("retriage_issue_changed")
  }
  await currentComments(github, live, candidate.createdAt, now)
  const history = await github.history(live.ref.number)
  requireHistory(history, now)
  const event = currentTransition(github, live, candidate, actor, history, admittedSource)
  await humanPermission(github, actor)
  return {
    request: {
      source: sourceFor(live.ref, event),
      candidateKey: candidate.candidateKey,
      createdAt: event.createdAt,
      actor: { ...actor },
    },
    issue: live,
    present: live.labels.includes(RETRIAGE_LABEL),
  }
}

/** Resolves a fresh human transition; an admitted source pins crash recovery. */
export async function inspectRetriage(
  github: GitHub,
  issue: Issue,
  candidate: RetriageCandidate,
  actor: Actor,
  admittedSource?: string,
  now = Date.now(),
): Promise<RetriageRequest> {
  return (await inspectCurrent(github, issue, candidate, actor, admittedSource, now)).request
}

/** Rechecks the exact admission and distinguishes proven bot cleanup from absence. */
export async function currentRetriage(
  github: GitHub,
  issue: Issue,
  request: RetriageRequest,
  now = Date.now(),
): Promise<{ issue: Issue; present: boolean }> {
  if (!request.source) throw new GitHubError("retriage_transition_not_current")
  const current = await inspectCurrent(github, issue, request, request.actor, request.source, now)
  if (current.request.source !== request.source)
    throw new GitHubError("retriage_transition_replaced")
  return { issue: current.issue, present: current.present }
}

/** Revalidates live permission, unchanged evidence, and original transition before claim. */
export async function validateRetriage(
  github: GitHub,
  issue: Issue,
  request: RetriageRequest,
): Promise<void> {
  await currentRetriage(github, issue, request)
}
