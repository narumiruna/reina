import { createHash } from "node:crypto"
import type { ProbotOctokit } from "probot"
import type { Issue, LabelEvent, Repository, Snapshot, SourceFile } from "../types.js"

export type GitHubClient = ProbotOctokit

/** Metadata returned by Probot installation authentication, not webhook input. */
export interface InstallationIdentity {
  token: string
  tokenType: "installation"
  installationId: number
  repositoryIds: (number | bigint)[]
  expiresAt: string
}

// Probot must use throttle.enabled=false. Its throttle plugin has no per-request
// switch and otherwise sleeps before this boundary can report rate limits.
export const requestOptions = { request: { retries: 0 } } as const
const pageSize = 100
const contextBytes = 128 * 1024
const fileBytes = 1024 * 1024
const snapshotBytes = 16 * fileBytes

export class GitHubError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code)
    this.name = "GitHubError"
  }
}

export class GitHubDeferred extends GitHubError {
  constructor(
    code: string,
    readonly retryAt: number,
  ) {
    super(code)
    this.name = "GitHubDeferred"
  }
}

/** Incomplete issue evidence must not pause unrelated GitHub work. */
export class GitHubIssueDeferred extends GitHubError {
  constructor(code: string) {
    super(code)
    this.name = "GitHubIssueDeferred"
  }
}

/** A rate-limit response confirms that this write was rejected. */
export class GitHubWriteRejected extends GitHubDeferred {
  constructor(retryAt: number) {
    super("github_write_rate_limit", retryAt)
    this.name = "GitHubWriteRejected"
  }
}

export class GitHubOutcomeUnknown extends GitHubError {
  constructor(code: string) {
    super(code)
    this.name = "GitHubOutcomeUnknown"
  }
}

export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined
  return typeof error.status === "number" ? error.status : undefined
}

export function rateLimit(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const response = "response" in error ? error.response : undefined
  const rawHeaders =
    typeof response === "object" && response !== null && "headers" in response
      ? response.headers
      : undefined
  const headers =
    typeof rawHeaders === "object" && rawHeaders !== null
      ? (rawHeaders as Record<string, string | undefined>)
      : {}
  const message = "message" in error && typeof error.message === "string" ? error.message : ""
  if (
    errorStatus(error) !== 429 &&
    !headers["retry-after"] &&
    headers["x-ratelimit-remaining"] !== "0" &&
    !(errorStatus(error) === 403 && /rate limit|secondary rate/i.test(message))
  ) {
    return undefined
  }
  const now = Date.now()
  const after = headers["retry-after"]
  const retry = after
    ? /^\d+(?:\.\d+)?$/.test(after)
      ? now + Number(after) * 1000
      : Date.parse(after)
    : 0
  const reset = Number(headers["x-ratelimit-reset"]) * 1000 + 1000
  return Math.max(
    now + 1000,
    Number.isFinite(retry) ? retry : 0,
    Number.isFinite(reset) ? reset : 0,
    !after && headers["x-ratelimit-remaining"] !== "0" ? now + 60_000 : 0,
  )
}

/** Initial read plus at most three transient retries; never wait in a webhook. */
export async function githubRead<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      if (error instanceof GitHubError) throw error
      const retryAt = rateLimit(error)
      if (retryAt !== undefined) throw new GitHubDeferred("github_rate_limit", retryAt)
      const status = errorStatus(error)
      if (status === undefined || [408, 500, 502, 503, 504].includes(status)) {
        if (attempt < 3) continue
        throw new GitHubDeferred("github_read_retry_exhausted", Date.now() + 60_000)
      }
      throw new GitHubError("github_read_failed", status)
    }
  }
}

/** Classify write backoff without retrying an operation with a possibly accepted outcome. */
export async function githubWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (error instanceof GitHubDeferred) throw error
    const retryAt = rateLimit(error)
    if (retryAt !== undefined) {
      if ([403, 429].includes(errorStatus(error) ?? 0)) throw new GitHubWriteRejected(retryAt)
      throw new GitHubDeferred("github_write_rate_limit", retryAt)
    }
    throw error
  }
}

function defer(code: string): never {
  throw new GitHubDeferred(code, Date.now() + 15 * 60_000)
}

export function numericId(value: number | bigint): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 1) throw new GitHubError("github_invalid_id")
  return id
}

export function sameRepository(a: Repository, b: Repository): boolean {
  return (
    a.id === b.id &&
    a.installationId === b.installationId &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  )
}

export function branchFor(number: number): string {
  numericId(number)
  return `narumi/fix/reina-issue-${number}`
}

export function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    Buffer.byteLength(path) <= 4096 &&
    !/[\\:]/.test(path) &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git" &&
          !/[. ]$/.test(part),
      )
  )
}

export function validSha(sha: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)
}

function validBranch(branch: string): boolean {
  return (
    safePath(branch) &&
    !/[~^?*[\s]/.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  )
}

export function gitHash(type: "blob" | "tree" | "commit", content: Buffer, length = 40): string {
  if (length !== 40 && length !== 64) throw new GitHubError("github_unsupported_hash")
  return createHash(length === 40 ? "sha1" : "sha256")
    .update(`${type} ${content.length}\0`)
    .update(content)
    .digest("hex")
}

export function decodeBase64(encoded: string, limit = fileBytes): Buffer {
  if (encoded.length > limit * 2 + 4) throw new GitHubError("github_blob_size")
  const clean = encoded.replace(/[\r\n]/g, "")
  const content = Buffer.from(clean, "base64")
  if (content.length > limit || content.toString("base64") !== clean) {
    throw new GitHubError("github_invalid_blob")
  }
  return content
}

type Page<T> = { data: T[]; headers: { link?: string } }

/** Use numbered pages only, never follow a response URL with credentials. */
export async function boundedList<T>(
  read: (page: number) => Promise<Page<T>>,
  maximum: number,
  bytes: (item: T) => number = () => 0,
  byteLimit = Number.MAX_SAFE_INTEGER,
  maxPages = 10,
): Promise<T[]> {
  const items: T[] = []
  let size = 0
  for (let page = 1; page <= maxPages; page++) {
    const response = await githubRead(() => read(page))
    if (!Array.isArray(response.data) || response.data.length > pageSize) {
      throw new GitHubError("github_invalid_page")
    }
    for (const item of response.data) {
      size += bytes(item)
      if (size > byteLimit || items.length === maximum) defer("github_read_limit")
      items.push(item)
    }
    // GitHub's Link header is the pagination authority, including a full last page.
    if (!response.headers.link?.split(",").some((link) => /;\s*rel="next"/.test(link))) {
      return items
    }
    if (response.data.length === 0) throw new GitHubError("github_incomplete_page")
    if (items.length === maximum) defer("github_pagination_limit")
  }
  return defer("github_pagination_limit")
}

export class GitHub {
  constructor(
    readonly client: GitHubClient,
    readonly repository: Repository,
    readonly botId: number,
    private readonly installation?: InstallationIdentity,
  ) {
    numericId(repository.id)
    numericId(repository.installationId)
    numericId(botId)
    if (!/^[\w.-]+$/.test(repository.owner) || !/^[\w.-]+$/.test(repository.name)) {
      throw new GitHubError("github_invalid_repository")
    }
  }

  get coordinates() {
    return { owner: this.repository.owner, repo: this.repository.name, ...requestOptions }
  }

  /** Check the supplied client's current installation, not a requested replacement. */
  async check() {
    const current = await githubRead(() => this.client.auth({ type: "installation" }))
    const auth = this.installation ?? current
    if (
      this.installation &&
      (typeof current !== "object" ||
        current === null ||
        !("token" in current) ||
        current.token !== this.installation.token ||
        !("tokenType" in current) ||
        current.tokenType !== "installation" ||
        this.installation.repositoryIds.length !== 1 ||
        numericId(this.installation.repositoryIds[0]) !== this.repository.id ||
        !Number.isFinite(Date.parse(this.installation.expiresAt)) ||
        Date.parse(this.installation.expiresAt) <= Date.now())
    ) {
      throw new GitHubError("github_installation_not_allowed")
    }
    if (
      typeof auth !== "object" ||
      auth === null ||
      !("installationId" in auth) ||
      auth.installationId !== this.repository.installationId ||
      !("tokenType" in auth) ||
      auth.tokenType !== "installation"
    ) {
      throw new GitHubError("github_installation_not_allowed")
    }
    const { data } = await githubRead(() => this.client.rest.repos.get(this.coordinates))
    if (
      numericId(data.id) !== this.repository.id ||
      data.name.toLowerCase() !== this.repository.name.toLowerCase() ||
      data.owner.login.toLowerCase() !== this.repository.owner.toLowerCase()
    ) {
      throw new GitHubError("github_repository_not_allowed")
    }
    return data
  }

  private async readComments(number: number) {
    const comments = await boundedList(
      (page) =>
        this.client.rest.issues.listComments({
          ...this.coordinates,
          issue_number: number,
          per_page: pageSize,
          page,
        }),
      100,
      (comment) => Buffer.byteLength(comment.body ?? ""),
      contextBytes,
      1,
    ).catch((error: unknown) => {
      if (
        error instanceof GitHubDeferred &&
        ["github_read_limit", "github_pagination_limit"].includes(error.code)
      ) {
        throw new GitHubIssueDeferred(error.code)
      }
      throw error
    })
    const ids = new Set<number>()
    for (const comment of comments) {
      const id = numericId(comment.id)
      if (ids.has(id)) throw new GitHubError("github_duplicate_comment")
      ids.add(id)
    }
    return comments
  }

  async comments(number: number) {
    numericId(number)
    await this.check()
    return this.readComments(number)
  }

  async issue(number: number): Promise<Issue> {
    numericId(number)
    await this.check()
    const { data } = await githubRead(() =>
      this.client.rest.issues.get({
        ...this.coordinates,
        issue_number: number,
      }),
    )
    if (data.number !== number) throw new GitHubError("github_issue_mismatch")
    if (data.comments > 100) throw new GitHubIssueDeferred("github_comments_limit")
    const comments = await this.readComments(number)
    if (comments.length !== data.comments)
      throw new GitHubIssueDeferred("github_issue_changed_during_read")
    if (
      Buffer.byteLength(data.title) +
        Buffer.byteLength(data.body ?? "") +
        comments.reduce((sum, comment) => sum + Buffer.byteLength(comment.body ?? ""), 0) >
      contextBytes
    ) {
      throw new GitHubIssueDeferred("github_context_limit")
    }
    return {
      ref: { ...this.repository, number, issueId: numericId(data.id) },
      title: data.title,
      body: data.body ?? "",
      comments: comments
        .filter((comment) => numericId(comment.user?.id ?? 0) !== this.botId)
        .map((comment) => ({
          id: numericId(comment.id),
          authorId: numericId(comment.user?.id ?? 0),
          body: comment.body ?? "",
        })),
      labels: data.labels.map((label) => (typeof label === "string" ? label : (label.name ?? ""))),
      state: data.state === "open" ? "open" : "closed",
      pullRequest: data.pull_request !== undefined,
    }
  }

  async head(): Promise<{ branch: string; sha: string }> {
    const metadata = await this.check()
    const branch = metadata.default_branch
    if (!validBranch(branch)) throw new GitHubError("github_invalid_branch")
    const sha = await this.readRef(branch)
    if (!sha) throw new GitHubError("github_missing_default_branch")
    return { branch, sha }
  }

  async snapshot(): Promise<Snapshot> {
    const { branch, sha } = await this.head()
    return this.snapshotAt(branch, sha)
  }

  async snapshotAt(branch: string, sha: string): Promise<Snapshot> {
    await this.check()
    return this.readSnapshot(branch, sha)
  }

  private async readSnapshot(branch: string, sha: string): Promise<Snapshot> {
    if (!validBranch(branch) || !validSha(sha)) throw new GitHubError("github_invalid_base")
    const { data: commit } = await githubRead(() =>
      this.client.rest.git.getCommit({
        ...this.coordinates,
        commit_sha: sha,
      }),
    )
    if (commit.sha !== sha || !validSha(commit.tree.sha))
      throw new GitHubError("github_commit_mismatch")
    const { data: tree } = await githubRead(() =>
      this.client.rest.git.getTree({
        ...this.coordinates,
        tree_sha: commit.tree.sha,
        recursive: "1",
      }),
    )
    if (tree.truncated !== false || tree.sha !== commit.tree.sha) {
      defer("github_incomplete_tree")
    }
    if (tree.tree.length > 10_000) defer("github_tree_limit")
    const paths = new Map<string, string>()
    let count = 0
    let size = 0
    for (const entry of tree.tree) {
      if (!safePath(entry.path) || paths.has(entry.path) || !validSha(entry.sha)) {
        throw new GitHubError("github_unsafe_tree")
      }
      paths.set(entry.path, entry.type)
      if (entry.type === "tree" && entry.mode === "040000") continue
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
        throw new GitHubError("github_unsupported_tree_mode")
      }
      if (entry.size === undefined || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new GitHubError("github_invalid_blob_size")
      }
      count++
      size += entry.size
      if (count > 2000 || entry.size > fileBytes || size > snapshotBytes)
        defer("github_snapshot_limit")
    }
    for (const path of paths.keys()) {
      const parts = path.split("/")
      for (let length = 1; length < parts.length; length++) {
        if (paths.get(parts.slice(0, length).join("/")) !== "tree") {
          throw new GitHubError("github_incomplete_tree")
        }
      }
    }
    const files: Record<string, SourceFile> = Object.create(null)
    let actualSize = 0
    for (const entry of tree.tree) {
      if (entry.type === "tree") continue
      const { data: blob } = await githubRead(() =>
        this.client.rest.git.getBlob({
          ...this.coordinates,
          file_sha: entry.sha,
        }),
      )
      if (blob.encoding !== "base64" || blob.sha !== entry.sha || blob.size !== entry.size) {
        throw new GitHubError("github_blob_mismatch")
      }
      const content = decodeBase64(blob.content)
      actualSize += content.length
      if (
        content.length !== entry.size ||
        gitHash("blob", content, entry.sha.length) !== entry.sha
      ) {
        throw new GitHubError("github_blob_mismatch")
      }
      if (actualSize > snapshotBytes) defer("github_snapshot_limit")
      files[entry.path] = { content, mode: entry.mode as SourceFile["mode"] }
    }
    return { branch, sha, files }
  }

  async discover(limit: number, page = 1): Promise<{ numbers: number[]; nextPage: number }> {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(page) ||
      page < 1
    )
      throw new GitHubError("github_scan_limit")
    await this.check()
    const { data, headers } = await githubRead(() =>
      this.client.rest.issues.listForRepo({
        ...this.coordinates,
        state: "open",
        sort: "created",
        direction: "asc",
        per_page: limit,
        page,
      }),
    )
    if (data.length > limit) throw new GitHubError("github_scan_response_limit")
    const numbers = data
      .filter(
        (issue) =>
          !issue.pull_request &&
          issue.state === "open" &&
          !issue.labels.some(
            (label) => (typeof label === "string" ? label : label.name) === "bot:skip",
          ),
      )
      .map((issue) => numericId(issue.number))
    if (new Set(numbers).size !== numbers.length) throw new GitHubError("github_duplicate_issue")
    const nextPage = headers.link?.includes('rel="next"') ? page + 1 : 1
    if (!Number.isSafeInteger(nextPage)) throw new GitHubError("github_scan_limit")
    return { numbers, nextPage }
  }

  async history(number: number): Promise<LabelEvent[]> {
    numericId(number)
    await this.check()
    const events = await boundedList(
      (page) =>
        this.client.rest.issues.listEvents({
          ...this.coordinates,
          issue_number: number,
          per_page: pageSize,
          page,
        }),
      1000,
    )
    const ids = new Set<string>()
    const labels: LabelEvent[] = []
    let previousTime = 0
    for (const event of events) {
      const id = String(event.id)
      if (!/^\d+$/.test(id) || id === "0" || ids.has(id))
        throw new GitHubError("github_ambiguous_history")
      ids.add(id)
      const labeled = event.event === "labeled" || event.event === "unlabeled"
      if (!labeled && event.event !== "closed" && event.event !== "reopened") continue
      const createdAt = Date.parse(event.created_at)
      const label = labeled && "label" in event ? event.label?.name : ""
      if ((labeled && !label) || !event.actor || !Number.isFinite(createdAt)) {
        throw new GitHubError("github_ambiguous_history")
      }
      if (createdAt < previousTime) throw new GitHubError("github_ambiguous_history")
      previousTime = createdAt
      labels.push({
        id,
        event: event.event as LabelEvent["event"],
        label: label ?? "",
        createdAt,
        actor: { id: numericId(event.actor.id), login: event.actor.login, type: event.actor.type },
      })
    }
    return labels
  }

  async permission(login: string, actorId?: number): Promise<string> {
    await this.check()
    if (!/^[a-z\d-]+$/i.test(login)) throw new GitHubError("github_invalid_actor")
    const { data } = await githubRead(() =>
      this.client.rest.repos.getCollaboratorPermissionLevel({
        ...this.coordinates,
        username: login,
      }),
    )
    if (
      !data.user ||
      data.user.login.toLowerCase() !== login.toLowerCase() ||
      (actorId !== undefined && numericId(data.user.id) !== actorId)
    ) {
      throw new GitHubError("github_permission_mismatch")
    }
    return data.permission
  }

  async ref(branch: string): Promise<string | undefined> {
    await this.check()
    return this.readRef(branch)
  }

  private async readRef(branch: string): Promise<string | undefined> {
    if (!validBranch(branch)) throw new GitHubError("github_invalid_branch")
    try {
      const { data } = await githubRead(() =>
        this.client.rest.git.getRef({
          ...this.coordinates,
          ref: `heads/${branch}`,
        }),
      )
      if (
        data.ref !== `refs/heads/${branch}` ||
        data.object.type !== "commit" ||
        !validSha(data.object.sha)
      ) {
        throw new GitHubError("github_ref_mismatch")
      }
      return data.object.sha
    } catch (error) {
      if (errorStatus(error) === 404) return undefined
      throw error
    }
  }

  async pullRequests(number: number) {
    numericId(number)
    await this.check()
    return boundedList(
      (page) =>
        this.client.rest.pulls.list({
          ...this.coordinates,
          head: `${this.repository.owner}:${branchFor(number)}`,
          state: "all",
          per_page: pageSize,
          page,
        }),
      100,
      (pr) => Buffer.byteLength(pr.body ?? ""),
      1024 * 1024,
    )
  }

  async conflicts(number: number): Promise<boolean> {
    await this.check()
    const branch = await this.ref(branchFor(number))
    const prs = await this.pullRequests(number)
    return branch !== undefined || prs.length !== 0
  }
}
