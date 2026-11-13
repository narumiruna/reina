import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import {
  FixedGitHubConnectTransport,
  type GitHubConnectInstallation,
  type GitHubConnectRepository,
  type GitHubConnectTransport,
  type GitHubConnectUser,
} from "../github/connect.js"
import { dispatchSettingsSchema, repositoryNameSchema } from "../settings/dispatch.js"
import {
  type GitHubAppSettings,
  gitHubAppSettingsSchema,
  gitHubUserLoginSchema,
} from "../settings/github.js"
import type { SettingsStore } from "../settings/store.js"
import type { Auth } from "./auth.js"

export type { GitHubConnectTransport } from "../github/connect.js"

type Failure = "not_configured" | "expired" | "failed" | "access_denied" | "stale" | "limit"
export class GitHubConnectError extends Error {
  readonly code: `github_connect_${Failure}`
  readonly status: number

  constructor(reason: Failure) {
    super(`github_connect_${reason}`)
    this.name = "GitHubConnectError"
    this.code = `github_connect_${reason}`
    this.status = {
      not_configured: 409,
      expired: 410,
      failed: 400,
      access_denied: 403,
      stale: 409,
      limit: 429,
    }[reason]
  }
}

export interface GitHubConnectStatus {
  configured: boolean
  appId?: number
  clientSecretConfigured: boolean
  webhookSecretConfigured: boolean
  privateKeyConfigured: boolean
  callbackUrl: string
  setupUrl: string
}
export interface GitHubConnectChoice {
  id: number
  owner: string
  name: string
  fullName: string
  installationId: number
}
export interface GitHubConnectView {
  state: "idle" | "connecting" | "select_repository" | "install_required"
  repositories: GitHubConnectChoice[]
  user?: GitHubConnectUser
  expiresAt?: number
}

type Snapshot = { app: GitHubAppSettings; privateKey: string; revision: string }
type Work = {
  owner: string
  controller: AbortController
  deadline: number
  timer: ReturnType<typeof setTimeout>
}
type Flow = Work & {
  snapshot: Snapshot
  phase: "oauth" | "ready" | "install" | "busy"
  state?: string
  verifier?: string
  token?: string
  user?: GitHubConnectUser
  repositories: GitHubConnectChoice[]
}

const TTL = 15 * 60 * 1000
const MAX_FLOWS = 64
const MAX_INSTALLATIONS = 16
const MAX_REPOSITORIES = 1000
const fields = gitHubAppSettingsSchema.shape
const inputSchema = z.strictObject({
  appId: fields.appId,
  clientSecret: z
    .preprocess((value) => (typeof value === "string" ? value.trim() : value), fields.clientSecret)
    .optional(),
  webhookSecret: fields.webhookSecret.optional(),
})
const secretsSchema = gitHubAppSettingsSchema.pick({
  appId: true,
  clientSecret: true,
  webhookSecret: true,
})
const userSchema = z.object({
  id: fields.appId,
  login: gitHubUserLoginSchema,
})
const choiceSchema = z.object({
  id: fields.appId,
  installationId: fields.appId,
  owner: dispatchSettingsSchema.shape.repository.shape.owner,
  name: repositoryNameSchema,
  fullName: z.string().max(140),
})

function opaque(): string {
  return randomBytes(32).toString("base64url")
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
function parameter(url: URL, name: string): string | undefined {
  const values = url.searchParams.getAll(name)
  return values.length === 1 ? values[0] : undefined
}

/** One session-bound connection per owner. User tokens never leave this object. */
export class GitHubConnect {
  private readonly flows = new Map<string, Flow>()
  private readonly saves = new Map<string, Work>()
  private readonly origin: string
  private closed = false

  constructor(
    private readonly settings: SettingsStore,
    private readonly auth: Pick<Auth, "ownerActive">,
    origin: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly transport: GitHubConnectTransport = new FixedGitHubConnectTransport(),
  ) {
    this.origin = new URL(origin).origin
  }

  status(): GitHubConnectStatus {
    try {
      const saved = this.settings.githubAppSettings()
      const legacy = saved ? undefined : this.legacy()
      const key = this.settings.githubStatus()
      return {
        configured: Boolean(saved && key.configured),
        ...(saved || legacy ? { appId: saved?.appId ?? legacy?.appId } : {}),
        clientSecretConfigured: Boolean(saved?.clientSecret),
        webhookSecretConfigured: Boolean(saved?.webhookSecret ?? legacy?.webhookSecret),
        privateKeyConfigured: key.configured,
        callbackUrl: this.callbackUrl,
        setupUrl: this.setupUrl,
      }
    } catch {
      throw new GitHubConnectError("failed")
    }
  }

  private get callbackUrl(): string {
    return new URL("/auth/github/callback", this.origin).href
  }
  private get setupUrl(): string {
    return new URL("/auth/github/setup", this.origin).href
  }

  private legacy(matchingAppId?: number): { appId: number; webhookSecret?: string } | undefined {
    const dispatch = this.settings.dispatchSettings()
    if (dispatch && (matchingAppId === undefined || dispatch.appId === matchingAppId))
      return { appId: dispatch.appId, webhookSecret: dispatch.webhookSecret }
    const raw = this.env.APP_ID
    if (!raw || !/^[1-9][0-9]*$/.test(raw)) return
    const appId = fields.appId.safeParse(Number(raw))
    if (!appId.success || (matchingAppId !== undefined && appId.data !== matchingAppId)) return
    const secret = fields.webhookSecret.safeParse(this.env.WEBHOOK_SECRET)
    return { appId: appId.data, ...(secret.success ? { webhookSecret: secret.data } : {}) }
  }

  private revision(): string {
    // Include explicit legacy settings while the first service App save is pending.
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.settings.githubRevision(),
          this.settings.githubStatus().fingerprint,
          this.settings.githubAppSettings()
            ? null
            : [this.legacy(), this.env.APP_ID, this.env.WEBHOOK_SECRET],
        ]),
      )
      .digest("hex")
  }

  private snapshot(): Snapshot {
    try {
      const app = this.settings.githubAppSettings()
      const privateKey = this.settings.privateKey()
      if (!app || !privateKey) throw new GitHubConnectError("not_configured")
      return { app, privateKey, revision: this.revision() }
    } catch (error) {
      throw error instanceof GitHubConnectError ? error : new GitHubConnectError("failed")
    }
  }

  async saveApp(owner: string, input: unknown): Promise<void> {
    this.checkOwner(owner)
    // Validate before any network request. Omitted secrets are write-only, same-App updates.
    const value = inputSchema.parse(input)
    let revision: string
    let privateKey: string
    let secrets: z.infer<typeof secretsSchema>
    try {
      const previous = this.settings.githubAppSettings()
      const same = previous?.appId === value.appId ? previous : undefined
      const legacy = previous ? undefined : this.legacy(value.appId)
      secrets = secretsSchema.parse({
        appId: value.appId,
        clientSecret: value.clientSecret ?? same?.clientSecret,
        webhookSecret:
          value.webhookSecret ??
          same?.webhookSecret ??
          (legacy?.appId === value.appId ? legacy.webhookSecret : undefined),
      })
      const key = this.settings.privateKey()
      if (!key) throw new GitHubConnectError("not_configured")
      privateKey = key
      revision = this.revision()
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof GitHubConnectError) throw error
      throw new GitHubConnectError("failed")
    }
    this.cancelOwner(owner)
    this.capacity()
    const work = this.work(owner)
    this.saves.set(owner, work)
    try {
      const signal = this.signal(work)
      const app = await this.transport.app({ appId: value.appId, privateKey }, signal)
      this.ensure(work, revision, signal)
      if (app.id !== value.appId) throw new GitHubConnectError("access_denied")
      const settings = gitHubAppSettingsSchema.parse({
        ...secrets,
        clientId: app.clientId,
        slug: app.slug,
      })
      this.settings.saveGitHubAppSettings(settings)
    } catch (error) {
      throw this.failure(work, error)
    } finally {
      this.stop(work)
    }
  }

  async start(owner: string): Promise<{ url: string }> {
    this.checkOwner(owner)
    const snapshot = this.snapshot()
    this.cancelOwner(owner)
    this.capacity()
    const flow: Flow = Object.assign(this.work(owner), {
      snapshot,
      phase: "oauth" as const,
      state: opaque(),
      verifier: opaque(),
      repositories: [],
    })
    this.flows.set(owner, flow)
    const url = new URL("https://github.com/login/oauth/authorize")
    url.searchParams.set("client_id", snapshot.app.clientId)
    url.searchParams.set("redirect_uri", this.callbackUrl)
    url.searchParams.set("state", flow.state as string)
    url.searchParams.set(
      "code_challenge",
      createHash("sha256")
        .update(flow.verifier as string)
        .digest("base64url"),
    )
    url.searchParams.set("code_challenge_method", "S256")
    return { url: url.href }
  }

  async oauthCallback(owner: string, url: URL): Promise<void> {
    const flow = this.consume(owner, url, "oauth", this.callbackUrl)
    try {
      if (url.searchParams.has("error")) throw new GitHubConnectError("access_denied")
      const code = parameter(url, "code")
      if (!code || !/^[A-Za-z0-9_.-]{1,4096}$/.test(code) || !flow.verifier)
        throw new GitHubConnectError("failed")
      const signal = this.signal(flow)
      const token = await this.transport.exchange(
        {
          clientId: flow.snapshot.app.clientId,
          clientSecret: flow.snapshot.app.clientSecret,
          code,
          verifier: flow.verifier,
          callbackUrl: this.callbackUrl,
        },
        signal,
      )
      this.ensure(flow, undefined, signal)
      if (!/^[A-Za-z0-9_.-]{1,4096}$/.test(token)) throw new GitHubConnectError("failed")
      delete flow.verifier
      flow.token = token
      flow.user = userSchema.parse(await this.transport.user(token, signal))
      this.ensure(flow, undefined, signal)
      flow.repositories = await this.choices(flow, signal)
      this.ensure(flow, undefined, signal)
      flow.phase = "ready"
    } catch (error) {
      const failure = this.failure(flow, error)
      this.stop(flow)
      throw failure
    }
  }

  view(owner: string): GitHubConnectView {
    this.checkOwner(owner)
    const flow = this.flows.get(owner)
    if (!flow) return { state: "idle", repositories: [] }
    try {
      this.ensure(flow)
    } catch {
      this.stop(flow)
      return { state: "idle", repositories: [] }
    }
    return {
      state:
        flow.phase === "oauth" || flow.phase === "busy"
          ? "connecting"
          : flow.repositories.length > 0
            ? "select_repository"
            : "install_required",
      repositories: structuredClone(flow.repositories),
      ...(flow.user ? { user: { ...flow.user } } : {}),
      expiresAt: flow.deadline,
    }
  }

  async refresh(owner: string): Promise<GitHubConnectView> {
    const flow = this.owned(owner)
    if (!flow.token || !flow.user || (flow.phase !== "ready" && flow.phase !== "install"))
      throw new GitHubConnectError("stale")
    flow.phase = "busy"
    delete flow.state
    try {
      const signal = this.signal(flow)
      const user = userSchema.parse(await this.transport.user(flow.token, signal))
      this.ensure(flow, undefined, signal)
      if (user.id !== flow.user.id || user.login !== flow.user.login)
        throw new GitHubConnectError("access_denied")
      flow.repositories = await this.choices(flow, signal)
      this.ensure(flow, undefined, signal)
      flow.phase = "ready"
      return this.view(owner)
    } catch (error) {
      const failure = this.failure(flow, error)
      this.stop(flow)
      throw failure
    }
  }

  async install(owner: string): Promise<{ url: string }> {
    const flow = this.owned(owner)
    if (!flow.token || !flow.user || (flow.phase !== "ready" && flow.phase !== "install"))
      throw new GitHubConnectError("stale")
    flow.state = opaque()
    flow.phase = "install"
    const url = new URL(`https://github.com/apps/${flow.snapshot.app.slug}/installations/new`)
    url.searchParams.set("state", flow.state)
    return { url: url.href }
  }

  async setupCallback(owner: string, url: URL): Promise<void> {
    const flow = this.consume(owner, url, "install", this.setupUrl)
    try {
      const rawId = parameter(url, "installation_id")
      const action = parameter(url, "setup_action")
      if (!rawId || !/^[1-9][0-9]*$/.test(rawId) || (action !== "install" && action !== "update"))
        throw new GitHubConnectError("access_denied")
      const installationId = fields.appId.parse(Number(rawId))
      const signal = this.signal(flow)
      const current = await this.transport.installation(
        this.credentials(flow),
        installationId,
        signal,
      )
      this.ensure(flow, undefined, signal)
      this.checkInstallation(flow, current, installationId)
      // App authentication proves App ownership, not the user's access. Require both.
      flow.repositories = await this.choices(flow, signal, installationId)
      this.ensure(flow, undefined, signal)
      flow.phase = "ready"
    } catch (error) {
      const failure = this.failure(flow, error)
      this.stop(flow)
      throw failure
    }
  }

  async select(owner: string, repositoryId: number): Promise<void> {
    const flow = this.owned(owner)
    if (flow.phase !== "ready" && flow.phase !== "install") throw new GitHubConnectError("stale")
    const choice = flow.repositories.find((repository) => repository.id === repositoryId)
    if (!choice || !flow.token || !flow.user) throw new GitHubConnectError("access_denied")
    // Reserve consumption before the first await. Parallel submissions cannot both commit.
    flow.phase = "busy"
    delete flow.state
    try {
      const signal = this.signal(flow)
      const user = userSchema.parse(await this.transport.user(flow.token, signal))
      this.ensure(flow, undefined, signal)
      if (user.id !== flow.user.id || user.login !== flow.user.login)
        throw new GitHubConnectError("access_denied")
      const current = await this.transport.installation(
        this.credentials(flow),
        choice.installationId,
        signal,
      )
      this.ensure(flow, undefined, signal)
      this.checkInstallation(flow, current, choice.installationId)
      const installations = await this.accessible(flow, signal)
      if (!installations.some((value) => value.id === choice.installationId))
        throw new GitHubConnectError("access_denied")
      const repositories = await this.repositories(flow, choice.installationId, signal)
      if (!repositories.some((value) => this.sameChoice(value, choice)))
        throw new GitHubConnectError("access_denied")
      this.ensure(flow, undefined, signal)
      this.settings.saveGitHubConnection({
        appId: flow.snapshot.app.appId,
        repository: {
          id: choice.id,
          owner: choice.owner,
          name: choice.name,
          installationId: choice.installationId,
        },
        connectedAt: Date.now(),
        user,
      })
    } catch (error) {
      throw this.failure(flow, error)
    } finally {
      // Local discard only. No claim is made that GitHub has revoked this token.
      this.stop(flow)
    }
  }

  cancelOwner(owner: string): void {
    const flow = this.flows.get(owner)
    if (flow) this.stop(flow)
    const save = this.saves.get(owner)
    if (save) this.stop(save)
  }

  close(): void {
    this.closed = true
    for (const flow of this.flows.values()) this.stop(flow)
    for (const save of this.saves.values()) this.stop(save)
  }

  private work(owner: string): Work {
    const work: Work = {
      owner,
      controller: new AbortController(),
      deadline: Date.now() + TTL,
      timer: setTimeout(() => this.stop(work), TTL),
    }
    work.timer.unref()
    return work
  }

  private stop(work: Work): void {
    clearTimeout(work.timer)
    work.controller.abort()
    if (this.saves.get(work.owner) === work) this.saves.delete(work.owner)
    const flow = this.flows.get(work.owner)
    if (flow === work) {
      delete flow.token
      delete flow.state
      delete flow.verifier
      flow.repositories = []
      this.flows.delete(work.owner)
    }
  }

  private checkOwner(owner: string): void {
    if (this.closed || !this.auth.ownerActive(owner)) {
      this.cancelOwner(owner)
      throw new GitHubConnectError("access_denied")
    }
  }

  private capacity(): void {
    for (const work of [...this.flows.values(), ...this.saves.values()]) {
      if (Date.now() >= work.deadline || !this.auth.ownerActive(work.owner)) this.stop(work)
    }
    if (this.flows.size + this.saves.size >= MAX_FLOWS) throw new GitHubConnectError("limit")
  }

  private owned(owner: string): Flow {
    this.checkOwner(owner)
    const flow = this.flows.get(owner)
    if (!flow) throw new GitHubConnectError("expired")
    this.ensure(flow)
    return flow
  }

  private ensure(work: Work, revision?: string, signal?: AbortSignal): void {
    if (Date.now() >= work.deadline) {
      this.stop(work)
      throw new GitHubConnectError("expired")
    }
    this.checkOwner(work.owner)
    if (
      work.controller.signal.aborted ||
      (this.flows.get(work.owner) !== work && this.saves.get(work.owner) !== work)
    )
      throw new GitHubConnectError("stale")
    if (signal?.aborted) {
      this.stop(work)
      throw new GitHubConnectError("failed")
    }
    const flow = this.flows.get(work.owner)
    let current: string
    try {
      current = this.revision()
    } catch {
      this.stop(work)
      throw new GitHubConnectError("failed")
    }
    if (current !== (revision ?? flow?.snapshot.revision)) {
      this.stop(work)
      throw new GitHubConnectError("stale")
    }
  }

  private signal(work: Work): AbortSignal {
    return AbortSignal.any([
      work.controller.signal,
      AbortSignal.timeout(Math.min(30_000, Math.max(1, work.deadline - Date.now()))),
    ])
  }

  private failure(work: Work, error: unknown): GitHubConnectError {
    if (error instanceof GitHubConnectError) return error
    if (Date.now() >= work.deadline) return new GitHubConnectError("expired")
    if (this.closed || !this.auth.ownerActive(work.owner))
      return new GitHubConnectError("access_denied")
    if (work.controller.signal.aborted) return new GitHubConnectError("stale")
    return new GitHubConnectError("failed")
  }

  private consume(owner: string, url: URL, phase: "oauth" | "install", target: string): Flow {
    const flow = this.owned(owner)
    const state = parameter(url, "state")
    if (
      flow.phase !== phase ||
      !flow.state ||
      !state ||
      state.length > 128 ||
      !equal(state, flow.state) ||
      url.origin !== this.origin ||
      url.pathname !== new URL(target).pathname ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new GitHubConnectError("expired")
    // Consume before code, installation ID, or error validation and before all awaits.
    delete flow.state
    flow.phase = "busy"
    return flow
  }

  private credentials(flow: Flow) {
    return { appId: flow.snapshot.app.appId, privateKey: flow.snapshot.privateKey }
  }

  private checkInstallation(flow: Flow, value: GitHubConnectInstallation, expected: number): void {
    if (
      value.id !== expected ||
      value.appId !== flow.snapshot.app.appId ||
      value.suspended !== false
    )
      throw new GitHubConnectError("access_denied")
  }

  private async accessible(flow: Flow, signal: AbortSignal): Promise<GitHubConnectInstallation[]> {
    this.ensure(flow, undefined, signal)
    if (!flow.token) throw new GitHubConnectError("expired")
    const installations = await this.transport.installations(flow.token, signal)
    this.ensure(flow, undefined, signal)
    const values = installations.filter(
      (value) => value.appId === flow.snapshot.app.appId && value.suspended === false,
    )
    if (values.length > MAX_INSTALLATIONS) throw new GitHubConnectError("limit")
    if (
      values.some((value) => !fields.appId.safeParse(value.id).success) ||
      new Set(values.map((value) => value.id)).size !== values.length
    )
      throw new GitHubConnectError("failed")
    return values
  }

  private async repositories(
    flow: Flow,
    installationId: number,
    signal: AbortSignal,
  ): Promise<GitHubConnectChoice[]> {
    this.ensure(flow, undefined, signal)
    if (!flow.token) throw new GitHubConnectError("expired")
    const repositories = await this.transport.repositories(flow.token, installationId, signal)
    this.ensure(flow, undefined, signal)
    if (repositories.length > MAX_REPOSITORIES) throw new GitHubConnectError("limit")
    return repositories
      .filter(
        (value: GitHubConnectRepository) =>
          value.archived === false &&
          value.disabled === false &&
          (value.permissions.push === true ||
            value.permissions.admin === true ||
            value.permissions.maintain === true),
      )
      .map((value) => {
        const choice = choiceSchema.parse({ ...value, installationId })
        if (choice.fullName !== `${choice.owner}/${choice.name}`)
          throw new GitHubConnectError("failed")
        return choice
      })
  }

  private async choices(
    flow: Flow,
    signal: AbortSignal,
    requiredInstallation?: number,
  ): Promise<GitHubConnectChoice[]> {
    const installations = await this.accessible(flow, signal)
    if (
      requiredInstallation !== undefined &&
      !installations.some((value) => value.id === requiredInstallation)
    )
      throw new GitHubConnectError("access_denied")
    const choices: GitHubConnectChoice[] = []
    for (const value of installations) {
      choices.push(...(await this.repositories(flow, value.id, signal)))
      if (choices.length > MAX_REPOSITORIES) throw new GitHubConnectError("limit")
    }
    if (new Set(choices.map((value) => value.id)).size !== choices.length)
      throw new GitHubConnectError("failed")
    return choices
  }

  private sameChoice(left: GitHubConnectChoice, right: GitHubConnectChoice): boolean {
    return (
      left.id === right.id &&
      left.owner === right.owner &&
      left.name === right.name &&
      left.fullName === right.fullName &&
      left.installationId === right.installationId
    )
  }
}
