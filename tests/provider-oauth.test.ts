import { Buffer } from "node:buffer"
import { webcrypto } from "node:crypto"
import { Server } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { type Credential, type CredentialStore, createModels } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { modelRequestResolver } from "../src/settings/credentials.js"
import { getBuiltinProvider } from "../src/settings/providers.js"
import { ProviderSetup, type SetupCommitInput, type SetupView } from "../src/web/provider-setup.js"

// SDK 1.5.0 wire fixtures only. No provider login/refresh implementation is replaced.
const ids = ["openai-codex", "anthropic", "github-copilot", "kimi-coding", "meta", "xai"] as const
type Id = (typeof ids)[number]
type OAuth = Extract<Credential, { type: "oauth" }>
type Body = Record<string, unknown>
const owner = "fixture-active-owner"
const epoch = Date.parse("2030-01-01T00:00:00Z")
const code = "fixture-manual-code"
const deviceCode = "fixture-device-code"
const userCode = "FIXTURE-CODE"
const grant = "urn:ietf:params:oauth:grant-type:device_code"
const codexJwt = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }),
).toString("base64")}.fixture-signature`
const clients: Record<Id, string> = {
  "openai-codex": "app_EMoamEEZ73f0CkXaXp7hrann",
  anthropic: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "github-copilot": "Iv1.b507a08c87ecfe98",
  "kimi-coding": "17e5f671-d194-4dfb-9706-5516cb48c098",
  meta: "1031625952748946",
  xai: "b1a00492-073a-47ea-816f-4c329264a828",
}
const endpoints: Record<Id, { start: string; poll: string; token: string; verify: string }> = {
  "openai-codex": {
    start: "https://auth.openai.com/api/accounts/deviceauth/usercode",
    poll: "https://auth.openai.com/api/accounts/deviceauth/token",
    token: "https://auth.openai.com/oauth/token",
    verify: "https://auth.openai.com/codex/device",
  },
  anthropic: {
    start: "https://claude.ai/oauth/authorize",
    poll: "",
    token: "https://platform.claude.com/v1/oauth/token",
    verify: "https://claude.ai/oauth/authorize",
  },
  "github-copilot": {
    start: "https://github.com/login/device/code",
    poll: "https://github.com/login/oauth/access_token",
    token: "https://api.github.com/copilot_internal/v2/token",
    verify: "https://github.com/login/device",
  },
  "kimi-coding": {
    start: "https://auth.kimi.com/api/oauth/device_authorization",
    poll: "https://auth.kimi.com/api/oauth/token",
    token: "https://auth.kimi.com/api/oauth/token",
    verify: "https://auth.kimi.com/device",
  },
  meta: {
    start: "https://auth.meta.com/oidc/device/authorization/",
    poll: "https://auth.meta.com/oidc/device/token/",
    token: "https://api.meta.ai/muse-code/key",
    verify: "https://auth.meta.com/device",
  },
  xai: {
    start: "https://auth.x.ai/oauth2/device/code",
    poll: "https://auth.x.ai/oauth2/token",
    token: "https://auth.x.ai/oauth2/token",
    verify: "https://auth.x.ai/activate",
  },
}

type Step = {
  url: string
  method: "GET" | "POST"
  body?: Body
  headers?: Record<string, string>
  response: Body
  status: number
}
let steps: Step[]
let violations: unknown[]
let calls: { url: string; time: number; signal: AbortSignal }[]
const services: ProviderSetup[] = []

function post(url: string, body: Body, response: Body, json = false, status = 200) {
  steps.push({
    url,
    method: "POST",
    body,
    headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded" },
    response,
    status,
  })
}

function token(id: Id, rotated = false): Body {
  return {
    access_token: id === "openai-codex" ? codexJwt : `fixture-${id}-access${rotated ? "-new" : ""}`,
    refresh_token: `fixture-${id}-refresh${rotated ? "-new" : ""}`,
    expires_in: 3600,
  }
}

function startDevice(id: Id, expires = 600, verify = endpoints[id].verify) {
  const body: Body = { client_id: clients[id] }
  if (id === "github-copilot") body.scope = "read:user"
  if (id === "xai") {
    body.scope = "openid profile email offline_access grok-cli:access api:access"
    body.referrer = "pi"
  }
  post(
    endpoints[id].start,
    body,
    id === "openai-codex"
      ? { device_auth_id: deviceCode, user_code: userCode, interval: "1" }
      : {
          device_code: deviceCode,
          user_code: userCode,
          verification_uri: verify,
          verification_uri_complete: verify,
          interval: 1,
          expires_in: expires,
        },
    id === "openai-codex",
  )
}

function poll(id: Id, error?: string) {
  const body =
    id === "openai-codex"
      ? { device_auth_id: deviceCode, user_code: userCode }
      : { client_id: clients[id], device_code: deviceCode, grant_type: grant }
  const response = error
    ? { error }
    : id === "openai-codex"
      ? { authorization_code: code, code_verifier: "fixture-device-verifier" }
      : id === "github-copilot" || id === "meta"
        ? { access_token: `fixture-${id}-refresh` }
        : token(id)
  post(
    endpoints[id].poll,
    body,
    response,
    id === "openai-codex",
    error && id !== "github-copilot" ? 400 : 200,
  )
}

function copilotModels(access: string, enablePolicy: boolean) {
  steps.push({
    url: "https://api.individual.githubcopilot.com/models",
    method: "GET",
    headers: {
      authorization: `Bearer ${access}`,
      "editor-version": "vscode/1.107.0",
      "copilot-integration-id": "vscode-chat",
      "x-github-api-version": "2026-06-01",
    },
    response: {
      data: [
        {
          id: "claude-sonnet-4.6",
          model_picker_enabled: true,
          capabilities: { supports: { tool_calls: true } },
          policy: { state: enablePolicy ? "unconfigured" : "enabled" },
        },
      ],
    },
    status: 200,
  })
  if (enablePolicy) {
    // Explicit Reina consent precedes this real SDK policy-changing request (fixture only).
    post(
      "https://api.individual.githubcopilot.com/models/claude-sonnet-4.6/policy",
      { state: "enabled" },
      {},
      true,
    )
    const policy = steps.at(-1)
    if (policy) policy.headers = { ...policy.headers, authorization: `Bearer ${access}` }
  }
}

function finishLogin(id: Id) {
  if (id === "openai-codex") {
    post(
      endpoints[id].token,
      {
        grant_type: "authorization_code",
        client_id: clients[id],
        code,
        code_verifier: "fixture-device-verifier",
        redirect_uri: "https://auth.openai.com/deviceauth/callback",
      },
      token(id),
    )
  } else if (id === "github-copilot" || id === "meta") {
    refreshSteps(id, false)
  }
}

function refreshSteps(id: Id, rotated = true, status = 200) {
  const refresh = `fixture-${id}-refresh`
  if (id === "github-copilot") {
    const access = `fixture-copilot-access${rotated ? "-new" : ""}`
    steps.push({
      url: endpoints[id].token,
      method: "GET",
      headers: { authorization: `Bearer ${refresh}`, "user-agent": "GitHubCopilotChat/0.35.0" },
      response:
        status === 200
          ? { token: access, expires_at: epoch / 1000 + 3600 }
          : { error: "invalid_grant" },
      status,
    })
    if (status === 200) copilotModels(access, !rotated)
  } else if (id === "meta") {
    post(
      endpoints[id].token,
      {},
      status === 200
        ? { api_key: `fixture-meta-access${rotated ? "-new" : ""}` }
        : { error: "invalid_grant" },
      true,
      status,
    )
    const mint = steps.at(-1)
    if (mint)
      mint.headers = {
        ...mint.headers,
        authorization: `Bearer ${refresh}`,
        "x-api-version": "1.0.0",
      }
  } else {
    post(
      endpoints[id].token,
      {
        grant_type: "refresh_token",
        client_id: clients[id],
        refresh_token: refresh,
      },
      status === 200 ? token(id, rotated) : { error: "invalid_grant" },
      id === "anthropic",
      status,
    )
  }
}

function setup() {
  const committed: SetupCommitInput[] = []
  const commit = vi.fn(async (input: SetupCommitInput, signal: AbortSignal) => {
    signal.throwIfAborted()
    committed.push(structuredClone(input))
    return "fixture-saved-provider"
  })
  const service = new ProviderSetup({ commit, isOwnerActive: (value) => value === owner })
  services.push(service)
  return { service, commit, committed }
}

function start(service: ProviderSetup, id: Id) {
  return service.start(owner, {
    providerId: id,
    authType: "oauth",
    confirmPolicyChanges: id === "github-copilot",
  })
}

// Native delay lets dynamic SDK imports and WebCrypto finish; simulated polling is bounded.
async function until(
  service: ProviderSetup,
  flow: SetupView,
  done: (view: SetupView) => boolean,
  advance = false,
) {
  for (let i = 0; i < 100; i++) {
    const view = service.get(owner, flow.id)
    if (done(view)) return view
    await delay(1)
    const current = service.get(owner, flow.id)
    if (done(current)) return current
    await vi.advanceTimersByTimeAsync(advance ? 1000 : 0)
  }
  throw new Error(`fixture flow did not settle: ${JSON.stringify(service.get(owner, flow.id))}`)
}

async function manual(service: ProviderSetup, flow: SetupView, format = "code#state") {
  const view = await until(service, flow, (value) => value.status === "prompt")
  expect(view.prompt?.type).toBe("manual_code")
  expect(view.event?.type).toBe("auth_url")
  if (view.event?.type !== "auth_url" || !view.prompt) throw new Error("fixture prompt missing")
  const url = new URL(view.event.url)
  const state = url.searchParams.get("state")
  expect(state).toMatch(/^[\w-]{43}$/)
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://platform.claude.com/oauth/code/callback",
  )
  expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  const challenge = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", Buffer.from(state ?? "")),
  ).toString("base64url")
  expect(url.searchParams.get("code_challenge")).toBe(challenge)
  post(
    endpoints.anthropic.token,
    {
      grant_type: "authorization_code",
      client_id: clients.anthropic,
      code,
      state,
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      code_verifier: state,
    },
    token("anthropic"),
    true,
  )
  const answer =
    format === "code"
      ? code
      : format === "url"
        ? `https://platform.claude.com/oauth/code/callback?code=${code}&state=${state}`
        : `${code}#${state}`
  service.respond(owner, flow.id, view.prompt.id, answer)
  expect(() => service.respond(owner, flow.id, view.prompt?.id ?? "", answer)).toThrow(
    "stale_prompt",
  )
}

async function login(id: Id, backoff = false) {
  if (id !== "anthropic") {
    startDevice(id)
    if (backoff) {
      poll(id, id === "openai-codex" ? "deviceauth_authorization_pending" : "authorization_pending")
      poll(id, "slow_down")
    }
    poll(id)
    finishLogin(id)
  }
  const fixture = setup()
  const flow = start(fixture.service, id)
  if (id === "anthropic") await manual(fixture.service, flow)
  const view = await until(fixture.service, flow, (value) => value.status === "complete", true)
  expect(view).toEqual({
    id: flow.id,
    providerId: id,
    authType: "oauth",
    status: "complete",
    savedProviderId: "fixture-saved-provider",
  })
  expect(fixture.commit).toHaveBeenCalledOnce()
  const credential = fixture.committed[0]?.credential
  if (credential?.type !== "oauth") throw new Error("fixture OAuth credential missing")
  expect(credential.expires).toBeGreaterThan(Date.now())
  expect(credential.access).toBe(
    id === "openai-codex"
      ? codexJwt
      : id === "github-copilot"
        ? "fixture-copilot-access"
        : `fixture-${id}-access`,
  )
  expect(credential.refresh).toBe(`fixture-${id}-refresh`)
  if (id === "openai-codex") expect(credential.accountId).toBe("fixture-account")
  if (id === "github-copilot") {
    expect(credential.enterpriseUrl).toBeUndefined()
    expect(credential.availableModelIds).toEqual(["claude-sonnet-4.6"])
  }
  expect(JSON.stringify(view)).not.toMatch(/fixture-.*(?:access|refresh)|credential|accountId/)
  return { ...fixture, credential }
}

function authFixture(id: Id, credential: OAuth) {
  let stored: Credential = { ...credential, expires: Date.now() - 1 }
  const writes: Credential[] = []
  const credentials: CredentialStore = {
    read: async () => structuredClone(stored),
    list: async () => [{ providerId: id, type: "oauth" }],
    modify: async (providerId, update) => {
      expect(providerId).toBe(id)
      const next = await update(structuredClone(stored))
      if (next) {
        stored = structuredClone(next)
        writes.push(structuredClone(next))
      }
      return structuredClone(stored)
    },
    delete: vi.fn(async () => {
      throw new Error("fixture deletion forbidden")
    }),
  }
  const env = vi.fn(async () => {
    throw new Error("ambient env forbidden")
  })
  const fileExists = vi.fn(async () => {
    throw new Error("ambient files forbidden")
  })
  const models = createModels({ credentials, authContext: { env, fileExists } })
  const provider = getBuiltinProvider(id)
  if (!provider) throw new Error("fixture provider missing")
  models.setProvider(provider)
  return { models, writes, credentials, env, fileExists, read: () => stored }
}

beforeEach(() => {
  steps = []
  violations = []
  calls = []
  vi.stubEnv("KIMI_CODE_OAUTH_HOST", "")
  vi.stubEnv("KIMI_OAUTH_HOST", "")
  vi.stubGlobal("crypto", webcrypto)
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  })
  vi.setSystemTime(epoch)
  vi.spyOn(Server.prototype, "listen").mockImplementation(() => {
    throw new Error("loopback listener forbidden")
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      try {
        const step = steps.shift()
        const url = String(input)
        expect(step, `unplanned external request: ${url}`).toBeDefined()
        if (!step) throw new Error("network forbidden")
        expect(url).toBe(step.url)
        expect(init?.method ?? "GET").toBe(step.method)
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        const headers = new Headers(init?.headers)
        for (const [key, value] of Object.entries(step.headers ?? {}))
          expect(headers.get(key)).toBe(value)
        if (step.body) {
          const raw = String(init?.body)
          const body =
            headers.get("content-type") === "application/json"
              ? JSON.parse(raw)
              : Object.fromEntries(new URLSearchParams(raw))
          expect(body).toEqual(step.body)
        } else expect(init?.body).toBeUndefined()
        calls.push({ url, time: Date.now(), signal: init?.signal as AbortSignal })
        return Response.json(step.response, { status: step.status })
      } catch (error) {
        violations.push(error)
        throw error
      }
    }),
  )
})

afterEach(async () => {
  for (const service of services.splice(0)) service.close()
  await delay(1)
  try {
    expect(violations).toEqual([])
    expect(steps).toEqual([])
    expect(Server.prototype.listen).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
  }
})

describe("installed SDK 1.5.0 OAuth through ProviderSetup", () => {
  it.each(ids)("logs in and refreshes %s using only exact fixture requests", async (id) => {
    const { credential } = await login(id, id !== "anthropic")
    if (id !== "anthropic") {
      const polls = calls.filter((call) => call.url === endpoints[id].poll)
      expect(polls).toHaveLength(3)
      expect(polls[1].time - polls[0].time).toBe(1000)
      expect(polls[2].time - polls[1].time).toBe(6000)
    }
    const auth = authFixture(id, credential)
    refreshSteps(id)
    expect(await auth.models.getAuth(id)).toBeDefined()
    expect(auth.writes).toHaveLength(1)
    expect(auth.read()).toMatchObject({
      type: "oauth",
      access:
        id === "openai-codex"
          ? codexJwt
          : id === "github-copilot"
            ? "fixture-copilot-access-new"
            : `fixture-${id}-access-new`,
      // Copilot refreshes its API token; Meta re-mints a key. Their identity tokens do not rotate.
      refresh: `fixture-${id}-refresh${id === "github-copilot" || id === "meta" ? "" : "-new"}`,
    })
    expect((auth.read() as OAuth).expires).toBeGreaterThan(Date.now())
    expect(auth.env).not.toHaveBeenCalled()
    expect(auth.fileExists).not.toHaveBeenCalled()
  })

  it.each(ids)("preserves %s credentials after an actual SDK refresh failure", async (id) => {
    const { credential } = await login(id)
    const auth = authFixture(id, credential)
    const before = structuredClone(auth.read())
    refreshSteps(id, true, 401)
    await expect(auth.models.getAuth(id)).rejects.toThrow("OAuth refresh failed")
    expect(auth.read()).toEqual(before)
    expect(auth.writes).toEqual([])
    expect(auth.credentials.delete).not.toHaveBeenCalled()
    expect(auth.env).not.toHaveBeenCalled()
    expect(auth.fileExists).not.toHaveBeenCalled()
  })

  for (const error of ["access_denied", "expired_token"]) {
    it.each(ids.filter((id) => id !== "anthropic"))(
      `returns a safe %s error for ${error}`,
      async (id) => {
        startDevice(id)
        poll(id, error)
        const { service, commit } = setup()
        const flow = start(service, id)
        const view = await until(
          service,
          flow,
          (value) => value.status === "failed" || value.status === "expired",
          true,
        )
        expect(view).toMatchObject({
          status: error === "expired_token" ? "expired" : "failed",
          error:
            error === "expired_token"
              ? "provider_auth_login_expired"
              : "provider_auth_access_denied",
        })
        expect(commit).not.toHaveBeenCalled()
        expect(view.event).toBeUndefined()
        expect(view.prompt).toBeUndefined()
        expect(JSON.stringify(view)).not.toContain(deviceCode)
      },
    )
  }

  it.each(ids)("cancels actual %s SDK work without a commit or another request", async (id) => {
    if (id !== "anthropic") {
      startDevice(id)
      poll(id, id === "openai-codex" ? "deviceauth_authorization_pending" : "authorization_pending")
    }
    const { service, commit } = setup()
    const flow = start(service, id)
    const ready = await until(
      service,
      flow,
      (view) => (id === "anthropic" ? view.status === "prompt" : steps.length === 0),
      true,
    )
    if (id !== "anthropic") {
      expect(ready.event).toMatchObject({
        type: "device_code",
        userCode,
        verificationUri: endpoints[id].verify,
        openBrowserOnConfirm: false,
        copyCodeOnConfirm: false,
      })
    }
    service.cancel(owner, flow.id)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(service.get(owner, flow.id).status).toBe("cancelled")
    expect(calls.every((call) => call.signal.aborted)).toBe(true)
    expect(commit).not.toHaveBeenCalled()
    if (ready.prompt)
      expect(() => service.respond(owner, flow.id, ready.prompt?.id ?? "", code)).toThrow(
        "stale_prompt",
      )
  })

  it.each(ids.filter((id) => id !== "anthropic"))(
    "expires %s at the actual SDK device deadline without another poll",
    async (id) => {
      startDevice(id, 2)
      poll(id, id === "openai-codex" ? "deviceauth_authorization_pending" : "authorization_pending")
      const { service, commit } = setup()
      const flow = start(service, id)
      const view = await until(service, flow, () => steps.length === 0, true)
      expect(view.event?.type).toBe("device_code")
      const ttl = id === "openai-codex" ? 900_000 : 2000
      vi.setSystemTime(epoch + ttl)
      expect(service.get(owner, flow.id)).toMatchObject({
        status: "expired",
        error: "provider_auth_login_expired",
      })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(commit).not.toHaveBeenCalled()
      expect(calls.every((call) => call.signal.aborted)).toBe(true)
    },
  )

  it.each(["code", "url"])(
    "accepts Anthropic manual %s input without a callback listener",
    async (format) => {
      const { service, commit } = setup()
      const flow = start(service, "anthropic")
      await manual(service, flow, format)
      await until(service, flow, (view) => view.status === "complete")
      expect(commit).toHaveBeenCalledOnce()
    },
  )

  it("rejects an Anthropic manual-code state mismatch before token exchange", async () => {
    const { service, commit } = setup()
    const flow = start(service, "anthropic")
    const view = await until(service, flow, (value) => value.status === "prompt")
    service.respond(owner, flow.id, view.prompt?.id ?? "", `${code}#fixture-wrong-state`)
    expect(await until(service, flow, (value) => value.status === "failed")).toMatchObject({
      error: "provider_auth_login_failed",
    })
    expect(commit).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("requires Copilot policy-change consent before any SDK request", () => {
    const { service, commit } = setup()
    expect(() => service.start(owner, { providerId: "github-copilot", authType: "oauth" })).toThrow(
      "consent_required",
    )
    expect(fetch).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it.each(["KIMI_CODE_OAUTH_HOST", "KIMI_OAUTH_HOST"])(
    "rejects %s before actual login or host-side refresh",
    async (name) => {
      vi.stubEnv(name, "https://fixture-untrusted.invalid")
      const { service, commit } = setup()
      expect(() => start(service, "kimi-coding")).toThrow("unsupported_method")
      const credential: OAuth = {
        type: "oauth",
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: epoch - 1,
      }
      const provider = getBuiltinProvider("kimi-coding")
      const model = provider?.getModels()[0]
      if (!model) throw new Error("fixture Kimi model missing")
      const persist = {
        credentialState: () => ({
          sdkProviderId: "kimi-coding",
          generation: "fixture-generation",
          credential,
        }),
        refreshCredential: vi.fn(),
        deleteCredential: vi.fn(),
      }
      const resolve = modelRequestResolver(
        persist,
        "fixture-saved-provider",
        "fixture-generation",
        model,
      )
      await expect(resolve(new AbortController().signal)).rejects.toThrow("provider_auth_required")
      expect(persist.refreshCredential).not.toHaveBeenCalled()
      expect(persist.deleteCredential).not.toHaveBeenCalled()
      expect(commit).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})
