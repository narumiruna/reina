import { createHash } from "node:crypto"
import type { Nodes } from "mdast"
import { fromMarkdown } from "mdast-util-from-markdown"
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

function htmlCommentState(text: string, comment: boolean): boolean {
  let offset = 0
  for (;;) {
    const boundary = text.indexOf(comment ? "-->" : "<!--", offset)
    if (boundary === -1) return comment
    offset = boundary + (comment ? 3 : 4)
    comment = !comment
  }
}

interface CommandLine {
  raw: string
  visible: string
  canMention: boolean
}

/** Use source positions without decoding or stripping text into a command. */
function commandLines(body: string): CommandLine[] {
  const source = body.replace(/\r\n?/g, "\n")
  const rawLines = source.split("\n")
  const masked = source.split("")
  const excluded = new Set<number>()
  const textLines = new Set<number>()
  const textRanges: { start: number; end: number }[] = []
  const hidden = new Set<number>()
  let comment = false
  let nextLine = 1
  const fillComments = (through: number) => {
    while (nextLine <= through) {
      if (comment) hidden.add(nextLine)
      nextLine++
    }
  }
  const stack: { node: Nodes; parent?: Nodes["type"] }[] = [{ node: fromMarkdown(source) }]
  while (stack.length) {
    const { node, parent } = stack.pop() as { node: Nodes; parent?: Nodes["type"] }
    const position = node.position
    if (!position || position.start.offset === undefined || position.end.offset === undefined)
      throw new GitHubError("approval_comment_changed")
    const lastLine = position.end.line - (position.end.column === 1 ? 1 : 0)
    const blockHtml =
      node.type === "html" &&
      (parent === "root" || parent === "blockquote" || parent === "listItem")
    if (
      (["code", "blockquote", "definition"].includes(node.type) || blockHtml) &&
      !excluded.has(position.start.line)
    ) {
      for (let line = position.start.line; line <= lastLine; line++) excluded.add(line)
    }
    if (node.type === "text" && node.value.trim()) {
      textRanges.push({ start: position.start.offset, end: position.end.offset })
      for (let line = position.start.line; line <= lastLine; line++) textLines.add(line)
    }
    if (node.type === "html") {
      let line = position.start.line
      for (const fragment of node.value.split("\n")) {
        fillComments(line++)
        comment = htmlCommentState(fragment, comment)
      }
      for (let at = position.start.offset; at < position.end.offset; at++) {
        if (masked[at] !== "\n") masked[at] = " "
      }
    }
    if ("children" in node) {
      for (let i = node.children.length - 1; i >= 0; i--)
        stack.push({ node: node.children[i], parent: node.type })
    }
  }
  fillComments(rawLines.length)
  const visibleLines = masked.join("").split("\n")
  const lines: CommandLine[] = []
  let offset = 0
  let text = 0
  for (const [index, raw] of rawLines.entries()) {
    const first = offset + (raw.match(/^\s*/)?.[0].length ?? 0)
    while (text < textRanges.length && textRanges[text].end <= first) text++
    if (!excluded.has(index + 1) && !hidden.has(index + 1) && textLines.has(index + 1)) {
      lines.push({
        raw,
        visible: visibleLines[index],
        canMention:
          text < textRanges.length &&
          textRanges[text].start <= first &&
          first < textRanges[text].end,
      })
    }
    offset += raw.length + 1
  }
  return lines
}

function parseCommand(body: string, botLogin?: string): "help" | "fix" | undefined {
  if (!botLogin || !/^[a-z\d-]+(?:\[bot\])?$/i.test(botLogin)) return undefined
  const full = botLogin.toLowerCase()
  const alias = full.replace(/\[bot\]$/, "")
  let command: "help" | "fix" | undefined
  let addressed = false
  for (const { raw, visible, canMention } of commandLines(body)) {
    const mention = canMention
      ? /^ {0,3}@([a-z\d-]+(?:\[bot\])?)(?=$|[\s,:!?。，：！？])/i.exec(raw)
      : null
    if (mention) {
      const login = mention[1].toLowerCase()
      if (login !== full && login !== alias) {
        addressed = false
        continue
      }
      const instructions = visible
        .slice(mention[0].length)
        .replace(/^[\s,:!?。，：！？]+/, "")
        .trim()
      addressed = instructions.length === 0
      if (instructions && !/^help[.!?。！？]*$/i.test(instructions)) return "fix"
      command = "help"
    } else if (addressed && visible.trim()) {
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
