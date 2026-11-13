import { randomUUID } from "node:crypto"
import {
  type AuthEvent,
  type AuthPrompt,
  type AuthType,
  type Credential,
  type CredentialStore,
  createModels,
  type Provider,
} from "@earendil-works/pi-ai"
import { withProviderAuth } from "../settings/auth-network.js"
import {
  assertProviderEnvironment,
  getBuiltinProvider,
  isAllowedAuthorizationUrl,
  providerAuthMethods,
} from "../settings/providers.js"

export interface SetupInput {
  providerId: string
  authType: AuthType
  savedProviderId?: string
  expectedGeneration?: string
  confirmPolicyChanges?: boolean
}

type SetupFailure =
  | "not_found"
  | "owner_inactive"
  | "unsupported_method"
  | "consent_required"
  | "capacity"
  | "stale_prompt"
  | "invalid_response"
  | "unsafe_authorization_url"
  | "unsupported_prompt"
  | "access_denied"
  | "login_expired"
  | "login_failed"

const failureCodes = {
  not_found: "provider_setup_not_found",
  owner_inactive: "provider_setup_owner_inactive",
  unsupported_method: "provider_setup_unsupported_method",
  consent_required: "provider_setup_consent_required",
  capacity: "provider_setup_capacity",
  stale_prompt: "provider_setup_stale_prompt",
  invalid_response: "provider_setup_invalid_response",
  unsafe_authorization_url: "provider_auth_unsafe_authorization_url",
  unsupported_prompt: "provider_auth_unsupported_prompt",
  access_denied: "provider_auth_access_denied",
  login_expired: "provider_auth_login_expired",
  login_failed: "provider_auth_login_failed",
} as const

export type SetupErrorCode = (typeof failureCodes)[SetupFailure]

export class ProviderSetupError extends Error {
  readonly code: SetupErrorCode
  readonly status: number

  constructor(readonly reason: SetupFailure) {
    super(failureCodes[reason])
    this.name = "ProviderSetupError"
    this.code = failureCodes[reason]
    const statuses: Partial<Record<SetupFailure, number>> = {
      not_found: 404,
      owner_inactive: 403,
      capacity: 429,
      stale_prompt: 409,
      login_expired: 410,
    }
    this.status = statuses[reason] ?? 400
  }
}

type PublicPrompt = {
  id: string
  type: AuthPrompt["type"]
  message: string
  placeholder?: string
  options?: { id: string; label: string; description?: string }[]
}

export interface SetupView {
  id: string
  status: "pending" | "prompt" | "complete" | "failed" | "cancelled" | "expired"
  providerId: string
  authType: AuthType
  prompt?: PublicPrompt
  event?: AuthEvent
  error?: SetupErrorCode
  savedProviderId?: string
}

export interface SetupCommitInput {
  providerId: string
  authType: AuthType
  savedProviderId?: string
  expectedGeneration?: string
  credential: Credential
}

export interface ProviderSetupOptions {
  // The storage implementation must check signal and generation at its atomic write boundary.
  commit(input: SetupCommitInput, signal: AbortSignal): Promise<string>
  isOwnerActive(owner: string): boolean
  providers?: readonly Provider[]
}

type PendingPrompt = {
  id: string
  options?: readonly string[]
  resolve(value: string): void
  reject(): void
}

type Flow = {
  owner: string
  input: SetupInput
  view: SetupView
  controller: AbortController
  deadline: number
  discardAt: number
  prompt?: PendingPrompt
  responses: string[]
  interactions: number
  events: number
  headlessSelected: boolean
}

const TTL_MS = 15 * 60 * 1000
const MAX_FLOWS = 64
const MAX_OWNER_FLOWS = 4
const MAX_INTERACTIONS = 32
const MAX_EVENTS = 128

function active(flow: Flow): boolean {
  return flow.view.status === "pending" || flow.view.status === "prompt"
}

/** Session-bound, memory-only bridge to SDK-owned login implementations. */
export class ProviderSetup {
  private readonly flows = new Map<string, Flow>()
  private readonly timer: ReturnType<typeof setInterval>
  private closed = false

  constructor(private readonly options: ProviderSetupOptions) {
    this.timer = setInterval(() => this.sweep(), 1000)
    this.timer.unref()
  }

  start(owner: string, input: SetupInput): SetupView {
    this.sweep()
    if (this.closed || !this.options.isOwnerActive(owner))
      throw new ProviderSetupError("owner_inactive")
    const provider = this.options.providers
      ? this.options.providers.find((entry) => entry.id === input.providerId)
      : getBuiltinProvider(input.providerId)
    if (!provider || !providerAuthMethods(provider).includes(input.authType)) {
      throw new ProviderSetupError("unsupported_method")
    }
    if (
      input.authType === "oauth" &&
      provider.id === "github-copilot" &&
      input.confirmPolicyChanges !== true
    ) {
      throw new ProviderSetupError("consent_required")
    }
    if (input.authType === "oauth") {
      try {
        assertProviderEnvironment(provider.id)
      } catch {
        throw new ProviderSetupError("unsupported_method")
      }
    }
    if (
      this.flows.size >= MAX_FLOWS ||
      [...this.flows.values()].filter((flow) => flow.owner === owner && active(flow)).length >=
        MAX_OWNER_FLOWS
    ) {
      throw new ProviderSetupError("capacity")
    }
    const id = randomUUID()
    const flow: Flow = {
      owner,
      input: { ...input },
      view: { id, providerId: provider.id, authType: input.authType, status: "pending" },
      controller: new AbortController(),
      deadline: Date.now() + TTL_MS,
      discardAt: Date.now() + TTL_MS + 60_000,
      responses: [],
      interactions: 0,
      events: 0,
      headlessSelected: false,
    }
    this.flows.set(id, flow)
    void this.run(flow, provider)
    return this.snapshot(flow)
  }

  get(owner: string, id: string): SetupView {
    return this.snapshot(this.owned(owner, id))
  }

  respond(owner: string, id: string, promptId: string, value: string): SetupView {
    const flow = this.owned(owner, id)
    const prompt = flow.prompt
    if (!active(flow) || !prompt || prompt.id !== promptId)
      throw new ProviderSetupError("stale_prompt")
    if (
      typeof value !== "string" ||
      value.length > 8192 ||
      !value.trim() ||
      (prompt.options && !prompt.options.includes(value))
    ) {
      throw new ProviderSetupError("invalid_response")
    }
    flow.responses.push(value)
    prompt.resolve(value)
    return this.snapshot(flow)
  }

  cancel(owner: string, id: string): void {
    this.stop(this.owned(owner, id), "cancelled")
  }

  cancelOwner(owner: string): void {
    for (const flow of this.flows.values()) if (flow.owner === owner) this.stop(flow, "cancelled")
  }

  close(): void {
    this.closed = true
    clearInterval(this.timer)
    for (const flow of this.flows.values()) this.stop(flow, "cancelled")
    this.flows.clear()
  }

  private owned(owner: string, id: string): Flow {
    this.sweep()
    if (!this.options.isOwnerActive(owner)) {
      this.cancelOwner(owner)
      throw new ProviderSetupError("not_found")
    }
    const flow = this.flows.get(id)
    if (!flow || flow.owner !== owner) throw new ProviderSetupError("not_found")
    return flow
  }

  private snapshot(flow: Flow): SetupView {
    return structuredClone(flow.view)
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, flow] of this.flows) {
      if (active(flow)) {
        if (!this.options.isOwnerActive(flow.owner)) this.stop(flow, "cancelled")
        else if (now >= flow.deadline) this.stop(flow, "expired", "login_expired")
      }
      if (now >= flow.discardAt) this.flows.delete(id)
    }
  }

  private ensureActive(flow: Flow): void {
    if (Date.now() >= flow.deadline) this.stop(flow, "expired", "login_expired")
    if (!this.options.isOwnerActive(flow.owner) || this.closed) this.stop(flow, "cancelled")
    flow.controller.signal.throwIfAborted()
    if (!active(flow)) throw new ProviderSetupError("login_failed")
  }

  private stop(flow: Flow, status: SetupView["status"], error?: SetupFailure): void {
    if (!active(flow)) return
    flow.view.status = status
    flow.discardAt = Math.min(flow.discardAt, Date.now() + 60_000)
    if (error) flow.view.error = failureCodes[error]
    delete flow.view.prompt
    delete flow.view.event
    flow.prompt?.reject()
    flow.controller.abort()
    flow.responses = []
  }

  private text(flow: Flow, value: string, max = 300): string {
    let result = value
    for (const response of flow.responses) result = result.split(response).join("[redacted]")
    return result
      .replace(/https?:\/\/\S+/gi, "[link]")
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .slice(0, max)
  }

  private async prompt(flow: Flow, prompt: AuthPrompt): Promise<string> {
    this.ensureActive(flow)
    if (prompt.signal?.aborted) throw new ProviderSetupError("stale_prompt")
    if (++flow.interactions > MAX_INTERACTIONS || flow.prompt)
      throw new ProviderSetupError("unsupported_prompt")
    if (flow.input.authType === "oauth") {
      const id = flow.input.providerId
      if (!flow.headlessSelected && (id === "openai-codex" || id === "anthropic")) {
        const method = id === "openai-codex" ? "device_code" : "copy_code"
        if (prompt.type !== "select" || !prompt.options.some((option) => option.id === method))
          throw new ProviderSetupError("unsupported_prompt")
        flow.headlessSelected = true
        return method
      }
      if (!flow.headlessSelected && id === "github-copilot") {
        if (
          prompt.type !== "text" ||
          prompt.message !== "GitHub Enterprise URL/domain (blank for github.com)"
        )
          throw new ProviderSetupError("unsupported_prompt")
        flow.headlessSelected = true
        return ""
      }
      if (id !== "anthropic" || !flow.headlessSelected || prompt.type !== "manual_code")
        throw new ProviderSetupError("unsupported_prompt")
    }
    if (
      prompt.type === "select" &&
      (prompt.options.length < 1 ||
        prompt.options.length > 20 ||
        prompt.options.some((option) => !/^[\w.-]{1,100}$/.test(option.id)))
    )
      throw new ProviderSetupError("unsupported_prompt")
    const promptId = randomUUID()
    flow.view.prompt = {
      id: promptId,
      type: prompt.type,
      message: this.text(flow, prompt.message),
      ...(prompt.type !== "select" && prompt.placeholder
        ? { placeholder: this.text(flow, prompt.placeholder, 200) }
        : {}),
      ...(prompt.type === "select"
        ? {
            options: prompt.options.map((option) => ({
              id: option.id,
              label: this.text(flow, option.label, 100),
              ...(option.description ? { description: this.text(flow, option.description) } : {}),
            })),
          }
        : {}),
    }
    flow.view.status = "prompt"
    return new Promise<string>((resolve, reject) => {
      const finish = () => {
        prompt.signal?.removeEventListener("abort", abort)
        if (flow.prompt?.id === promptId) {
          delete flow.prompt
          delete flow.view.prompt
          if (active(flow)) flow.view.status = "pending"
        }
      }
      const abort = () => {
        finish()
        reject(new ProviderSetupError("stale_prompt"))
      }
      flow.prompt = {
        id: promptId,
        ...(prompt.type === "select" ? { options: prompt.options.map((option) => option.id) } : {}),
        resolve: (value) => {
          finish()
          resolve(value)
        },
        reject: abort,
      }
      prompt.signal?.addEventListener("abort", abort, { once: true })
      if (prompt.signal?.aborted || flow.controller.signal.aborted) abort()
    })
  }

  private notify(flow: Flow, event: AuthEvent): void {
    this.ensureActive(flow)
    if (++flow.events > MAX_EVENTS) throw new ProviderSetupError("login_failed")
    const checkUrl = (url: string) => {
      if (!isAllowedAuthorizationUrl(flow.input.providerId, url))
        throw new ProviderSetupError("unsafe_authorization_url")
      return url
    }
    switch (event.type) {
      case "auth_url":
        flow.view.event = {
          type: "auth_url",
          url: checkUrl(event.url),
          instructions: "Open this link to authorize your account.",
        }
        break
      case "device_code": {
        if (!/^[A-Za-z0-9 -]{1,128}$/.test(event.userCode))
          throw new ProviderSetupError("login_failed")
        const expires = event.expiresInSeconds
        if (expires !== undefined && (!Number.isFinite(expires) || expires <= 0))
          throw new ProviderSetupError("login_expired")
        if (expires !== undefined)
          flow.deadline = Math.min(flow.deadline, Date.now() + Math.min(expires, 900) * 1000)
        flow.view.event = {
          type: "device_code",
          userCode: event.userCode,
          verificationUri: checkUrl(event.verificationUri),
          openBrowserOnConfirm: false,
          copyCodeOnConfirm: false,
          ...(expires !== undefined ? { expiresInSeconds: Math.min(expires, 900) } : {}),
          ...(event.intervalSeconds !== undefined &&
          Number.isFinite(event.intervalSeconds) &&
          event.intervalSeconds > 0
            ? { intervalSeconds: Math.min(event.intervalSeconds, 60) }
            : {}),
        }
        break
      }
      case "info":
        flow.view.event = {
          type: "info",
          message: "Continue account authorization.",
          ...(event.links
            ? {
                links: event.links
                  .slice(0, 4)
                  .map((link) => ({ url: checkUrl(link.url), label: "Authorization" })),
              }
            : {}),
        }
        break
      case "progress":
        flow.view.event = { type: "progress", message: "Authentication in progress." }
        break
    }
  }

  private async run(flow: Flow, provider: Provider): Promise<void> {
    let staged: Credential | undefined
    let queue = Promise.resolve()
    const signal = flow.controller.signal
    const credentials: CredentialStore = {
      read: async () => staged,
      list: async () => (staged ? [{ providerId: provider.id, type: staged.type }] : []),
      modify: async (_id, modify) => {
        const operation = queue.then(async () => {
          this.ensureActive(flow)
          const next = await modify(staged)
          this.ensureActive(flow)
          if (next) staged = structuredClone(next)
          return staged
        })
        queue = operation.then(
          () => {},
          () => {},
        )
        return operation
      },
      delete: async () => {
        staged = undefined
      },
    }
    try {
      const models = createModels({
        credentials,
        authContext: { env: async () => undefined, fileExists: async () => false },
      })
      models.setProvider(provider)
      await withProviderAuth(provider.id, () =>
        models.login(provider.id, flow.input.authType, {
          signal,
          prompt: async (prompt) => {
            try {
              return await this.prompt(flow, prompt)
            } catch (error) {
              // A prompt-local abort can lose an SDK race without ending login.
              if (!(error instanceof ProviderSetupError && error.reason === "stale_prompt")) {
                this.stop(
                  flow,
                  "failed",
                  error instanceof ProviderSetupError ? error.reason : "login_failed",
                )
              }
              throw error
            }
          },
          notify: (event) => {
            try {
              this.notify(flow, event)
            } catch (error) {
              const code = error instanceof ProviderSetupError ? error.reason : "login_failed"
              this.stop(flow, code === "login_expired" ? "expired" : "failed", code)
              throw error
            }
          },
        }),
      )
      this.ensureActive(flow)
      if (
        !staged ||
        staged.type !== flow.input.authType ||
        (staged.type === "api_key" && !staged.key?.trim()) ||
        (staged.type === "oauth" &&
          (!staged.access ||
            !staged.refresh ||
            !Number.isFinite(staged.expires) ||
            staged.expires <= Date.now()))
      )
        throw new ProviderSetupError("login_failed")
      const savedProviderId = await this.options.commit(
        {
          providerId: provider.id,
          authType: flow.input.authType,
          ...(flow.input.savedProviderId !== undefined
            ? { savedProviderId: flow.input.savedProviderId }
            : {}),
          ...(flow.input.expectedGeneration !== undefined
            ? { expectedGeneration: flow.input.expectedGeneration }
            : {}),
          credential: staged,
        },
        signal,
      )
      this.ensureActive(flow)
      flow.discardAt = Math.min(flow.discardAt, Date.now() + 60_000)
      flow.view = {
        id: flow.view.id,
        providerId: provider.id,
        authType: flow.input.authType,
        status: "complete",
        savedProviderId,
      }
    } catch (error) {
      if (active(flow)) {
        if (Date.now() >= flow.deadline) {
          this.stop(flow, "expired", "login_expired")
          return
        }
        const message = error instanceof Error ? error.message : ""
        const code =
          error instanceof ProviderSetupError
            ? error.reason
            : /denied|access_denied/i.test(message)
              ? "access_denied"
              : /expired/i.test(message)
                ? "login_expired"
                : "login_failed"
        this.stop(flow, code === "login_expired" ? "expired" : "failed", code)
      }
    } finally {
      staged = undefined
      flow.responses = []
    }
  }
}
