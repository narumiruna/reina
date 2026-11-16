import { createHash } from "node:crypto"
import { Parser } from "commonmark"
import type { Actor, ExecutionRequest, Issue, LabelEvent } from "../types.js"
import { type GitHub, GitHubError, sameRepository } from "./scanner.js"

export type RequestCandidate =
  | Extract<ExecutionRequest, { kind: "comment" }>
  | { kind: "assignment"; assigneeId: number; createdAt: number }

function requireActor(github: GitHub, actor: Actor): void {
  if (
    actor.type !== "User" ||
    !Number.isSafeInteger(actor.id) ||
    actor.id < 1 ||
    actor.id === github.botId ||
    typeof actor.login !== "string" ||
    !/^[a-z\d-]+$/i.test(actor.login) ||
    actor.login.toLowerCase() === github.botLogin?.toLowerCase()
  ) {
    throw new GitHubError("approval_actor_mismatch")
  }
}

function sameActor(a: { id: number | bigint; login: string; type: string }, b: Actor): boolean {
  return Number(a.id) === b.id && a.login === b.login && a.type === b.type
}

function requireTime(createdAt: number, now: number): void {
  if (
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    !Number.isFinite(now) ||
    createdAt > now ||
    createdAt + 86_400_000 <= now
  ) {
    throw new GitHubError("approval_request_not_current")
  }
}

async function currentIssue(github: GitHub, issue: Issue): Promise<Issue> {
  if (!sameRepository(github.repository, issue.ref)) {
    throw new GitHubError("approval_repository_mismatch")
  }
  const live = await github.issue(issue.ref.number).catch((error: unknown) => {
    if (error instanceof GitHubError && error.status === 404)
      throw new GitHubError("approval_issue_not_eligible")
    throw error
  })
  if (
    !sameRepository(issue.ref, live.ref) ||
    live.ref.issueId !== issue.ref.issueId ||
    live.ref.number !== issue.ref.number
  ) {
    throw new GitHubError("approval_repository_mismatch")
  }
  if (live.state !== "open" || live.pullRequest || live.labels.includes("bot:skip")) {
    throw new GitHubError("approval_issue_not_eligible")
  }
  if (live.title !== issue.title || live.body !== issue.body)
    throw new GitHubError("approval_issue_changed")
  return live
}

async function humanPermission(github: GitHub, actor: Actor): Promise<string> {
  const permission = await github.permission(actor.login, actor.id).catch((error: unknown) => {
    if (error instanceof GitHubError) {
      if (["github_permission_mismatch", "github_invalid_actor"].includes(error.code))
        throw new GitHubError("approval_actor_mismatch")
      if (error.status === 403 || error.status === 404)
        throw new GitHubError("approval_permission_denied")
    }
    throw error
  })
  if (!["write", "maintain", "admin"].includes(permission)) {
    throw new GitHubError("approval_permission_denied")
  }
  return permission
}

function nonCommandLines(body: string): { excluded: Set<number>; quoted: Set<number> } {
  const excluded = new Set<number>()
  const quoted = new Set<number>()
  const walker = new Parser().parse(body).walker()
  for (let step = walker.next(); step; step = walker.next()) {
    const { node, entering } = step
    if (!entering || !["code_block", "html_block", "block_quote"].includes(node.type)) continue
    for (let line = node.sourcepos[0][0]; line <= node.sourcepos[1][0]; line++) {
      excluded.add(line)
      if (node.type === "block_quote") quoted.add(line)
    }
    // A protected container already covers all of its children.
    walker.resumeAt(node, false)
  }
  return { excluded, quoted }
}

/** Keep hidden text in place so removing markup cannot create a line-start command. */
function commandLines(body: string): string[] {
  const lines: string[] = []
  let comment = false
  let quotedParagraph = false
  let inlineTicks: number | undefined
  const { excluded, quoted } = nonCommandLines(body)
  for (const [index, raw] of body.split(/\r\n?|\n/).entries()) {
    if (quoted.has(index + 1)) quotedParagraph = true
    if (excluded.has(index + 1)) continue
    const hiddenPrefix = comment
    let visible = ""
    let offset = 0
    while (offset < raw.length) {
      const boundary = raw.indexOf(comment ? "-->" : "<!--", offset)
      const end = boundary === -1 ? raw.length : boundary + (comment ? 3 : 4)
      visible += comment
        ? " ".repeat(end - offset)
        : raw.slice(offset, boundary === -1 ? end : boundary)
      if (!comment && boundary !== -1) visible += "    "
      offset = end
      if (boundary !== -1) comment = !comment
    }
    // A blockquote paragraph can continue lazily on lines without another > marker.
    if (!visible.trim()) quotedParagraph = false
    if (/^ {0,3}>/.test(visible)) quotedParagraph = true
    if (hiddenPrefix || quotedParagraph || /^(?: {4}|\t)/.test(visible)) continue
    const insideCode = inlineTicks !== undefined
    for (const match of visible.matchAll(/`+/g)) {
      let escapes = 0
      for (let at = match.index - 1; at >= 0 && visible[at] === "\\"; at--) escapes++
      if (escapes % 2) continue
      if (inlineTicks === undefined) inlineTicks = match[0].length
      else if (inlineTicks === match[0].length) inlineTicks = undefined
    }
    if (insideCode || /^ {0,3}`/.test(visible)) continue
    lines.push(visible)
  }
  return lines
}

function parseCommand(body: string, botLogin?: string): "help" | "fix" | undefined {
  if (!botLogin || !/^[a-z\d-]+(?:\[bot\])?$/i.test(botLogin)) return undefined
  const full = botLogin.toLowerCase()
  const alias = full.replace(/\[bot\]$/, "")
  let command: "help" | "fix" | undefined
  let addressed = false
  for (const line of commandLines(body)) {
    const mention = /^ {0,3}@([a-z\d-]+(?:\[bot\])?)(?=$|[\s,:!?。，：！？])/i.exec(line)
    if (mention) {
      const login = mention[1].toLowerCase()
      if (login !== full && login !== alias) {
        addressed = false
        continue
      }
      const instructions = line
        .slice(mention[0].length)
        .replace(/^[\s,:!?。，：！？]+/, "")
        .trim()
      addressed = instructions.length === 0
      if (instructions && !/^help[.!?。！？]*$/i.test(instructions)) return "fix"
      command = "help"
    } else if (addressed && line.trim()) {
      // Instructions can start on the next visible line after a bare mention.
      return "fix"
    }
  }
  return command
}

async function currentComments(
  github: GitHub,
  issue: Issue,
  candidate: RequestCandidate,
  now: number,
) {
  const comments = await github.comments(issue.ref.number)
  for (const comment of comments) {
    if (
      Number(comment.user?.id) === github.botId ||
      (candidate.kind === "comment" && Number(comment.id) === candidate.commentId)
    )
      continue
    const createdAt = Date.parse(comment.created_at)
    const updatedAt = Date.parse(comment.updated_at)
    const later =
      createdAt > candidate.createdAt ||
      (createdAt === candidate.createdAt &&
        (candidate.kind === "assignment" || comment.id > candidate.commentId))
    if (
      !Number.isFinite(createdAt) ||
      !Number.isFinite(updatedAt) ||
      updatedAt < createdAt ||
      updatedAt > now ||
      later ||
      (updatedAt > createdAt && updatedAt >= candidate.createdAt)
    ) {
      throw new GitHubError("approval_issue_changed")
    }
  }
  return comments
}

function commentBody(
  comments: Awaited<ReturnType<GitHub["comments"]>>,
  request: Extract<ExecutionRequest, { kind: "comment" }>,
  actor: Actor,
): string {
  if (
    !Number.isSafeInteger(request.commentId) ||
    request.commentId < 1 ||
    !/^[a-f\d]{64}$/.test(request.bodyHash) ||
    request.updatedAt !== request.createdAt
  ) {
    throw new GitHubError("approval_comment_changed")
  }
  const comment = comments.find((item) => Number(item.id) === request.commentId)
  if (
    !comment?.user ||
    !sameActor(comment.user, actor) ||
    Date.parse(comment.created_at) !== request.createdAt ||
    Date.parse(comment.updated_at) !== request.updatedAt ||
    typeof comment.body !== "string" ||
    createHash("sha256").update(comment.body).digest("hex") !== request.bodyHash
  ) {
    throw new GitHubError("approval_comment_changed")
  }
  return comment.body
}

async function currentHistory(
  github: GitHub,
  issue: Issue,
  createdAt: number,
  now: number,
): Promise<LabelEvent[]> {
  const history = await github.history(issue.ref.number)
  if (history.some((event) => event.createdAt > now)) {
    throw new GitHubError("approval_history_not_current")
  }
  if (
    history.some(
      (event) =>
        event.createdAt >= createdAt && (event.event === "closed" || event.event === "reopened"),
    )
  ) {
    throw new GitHubError("approval_issue_lifecycle_changed")
  }
  // Removing an exclusion does not restore an older request either.
  if (history.some((event) => event.createdAt >= createdAt && event.label === "bot:skip")) {
    throw new GitHubError("approval_revoked")
  }
  return history
}

function assignmentRequest(
  github: GitHub,
  issue: Issue,
  candidate: Extract<RequestCandidate, { kind: "assignment" }>,
  actor: Actor,
  history: LabelEvent[],
): Extract<ExecutionRequest, { kind: "assignment" }> {
  const transitions = history.filter(
    (event) =>
      (event.event === "assigned" || event.event === "unassigned") &&
      event.assignee?.id === github.botId,
  )
  const event = transitions.at(-1)
  if (
    candidate.assigneeId !== github.botId ||
    !issue.assignees?.some((assignee) => assignee.id === github.botId) ||
    event?.event !== "assigned" ||
    event.createdAt !== candidate.createdAt ||
    !sameActor(event.actor, actor) ||
    transitions.some((other) => other.id !== event.id && other.createdAt === event.createdAt)
  ) {
    throw new GitHubError("approval_assignment_not_current")
  }
  return {
    kind: "assignment",
    eventId: event.id,
    assigneeId: github.botId,
    createdAt: event.createdAt,
  }
}

/** Convert signed webhook evidence into a live, human-authorized request. */
export async function inspectRequest(
  github: GitHub,
  issue: Issue,
  candidate: RequestCandidate,
  actor: Actor,
): Promise<
  { command: "help"; commentId: number } | { command: "fix"; request: ExecutionRequest } | undefined
> {
  requireActor(github, actor)
  const now = Date.now()
  requireTime(candidate.createdAt, now)
  const live = await currentIssue(github, issue)
  const comments = await currentComments(github, live, candidate, now)
  if (candidate.kind === "comment") {
    const body = commentBody(comments, candidate, actor)
    const command = parseCommand(body, github.botLogin)
    if (!command) return undefined
    await currentHistory(github, live, candidate.createdAt, now)
    await humanPermission(github, actor)
    return command === "help"
      ? { command, commentId: candidate.commentId }
      : { command, request: { ...candidate } }
  }
  const history = await currentHistory(github, live, candidate.createdAt, now)
  const request = assignmentRequest(github, live, candidate, actor, history)
  await humanPermission(github, actor)
  return { command: "fix", request }
}

/** Recheck the original request without granting a replacement attempt. */
export async function validateRequest(
  github: GitHub,
  issue: Issue,
  request: ExecutionRequest,
  actor: Actor,
  now = Date.now(),
): Promise<string> {
  requireActor(github, actor)
  requireTime(request.createdAt, now)
  const live = await currentIssue(github, issue)
  const comments = await currentComments(github, live, request, now)
  if (request.kind === "comment") {
    const body = commentBody(comments, request, actor)
    if (parseCommand(body, github.botLogin) !== "fix") {
      throw new GitHubError("approval_request_not_current")
    }
    await currentHistory(github, live, request.createdAt, now)
  } else {
    const history = await currentHistory(github, live, request.createdAt, now)
    const current = assignmentRequest(github, live, request, actor, history)
    if (current.eventId !== request.eventId) throw new GitHubError("approval_event_replaced")
  }
  return humanPermission(github, actor)
}
