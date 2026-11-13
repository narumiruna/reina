import { randomUUID } from "node:crypto"
import { Server } from "node:net"
import type { Credential, Provider, ProviderAuthInteraction } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  assertProviderEnvironment,
  catalogProviders,
  getBuiltinModel,
  getBuiltinProvider,
  isAllowedAuthorizationUrl,
  providerAuthMethods,
} from "../src/settings/providers.js"
import { ProviderSetup, type SetupView } from "../src/web/provider-setup.js"

const owner = "opaque-session-csrf"
const savedId = randomUUID()
const generation = randomUUID()
const account: Credential = {
  type: "oauth",
  access: "private-access",
  refresh: "private-refresh",
  expires: 9_999_999_999_999,
}
const urls: Record<string, string> = {
  "openai-codex": "https://auth.openai.com/codex/device",
  anthropic: "https://claude.ai/oauth/authorize?state=public-state",
  "github-copilot": "https://github.com/login/device",
  "kimi-coding": "https://auth.kimi.com/device?user_code=ABCD",
  meta: "https://auth.meta.com/device",
  xai: "https://auth.x.ai/activate",
}
const services: ProviderSetup[] = []

function fixture(
  id: string,
  login: (interaction: ProviderAuthInteraction) => Promise<Credential>,
): Provider {
  const provider = getBuiltinProvider(id)
  if (!provider) throw new Error("fixture provider missing")
  return {
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        name: "Fixture",
        login: async (interaction) => {
          const result = await login(interaction)
          if (result.type !== "oauth") throw new Error("fixture credential type")
          return result
        },
        refresh: async (credential) => credential,
        toAuth: async () => ({}),
      },
    },
  }
}

function setup(
  providers?: readonly Provider[],
  isOwnerActive: (value: string) => boolean = (value) => value === owner,
) {
  const commit = vi.fn(async () => savedId)
  const service = new ProviderSetup({ providers, commit, isOwnerActive })
  services.push(service)
  return { service, commit }
}

async function tick() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

async function settled(service: ProviderSetup, id: string): Promise<SetupView> {
  await tick()
  return service.get(owner, id)
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("network forbidden")
  })
  vi.spyOn(Server.prototype, "listen").mockImplementation(() => {
    throw new Error("listener forbidden")
  })
})

afterEach(() => {
  for (const service of services.splice(0)) service.close()
  expect(globalThis.fetch).not.toHaveBeenCalled()
  expect(Server.prototype.listen).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("static SDK registry", () => {
  it("exposes only six headless OAuth providers and actual interactive API-key methods", () => {
    const catalog = catalogProviders()
    expect(
      catalog
        .filter((provider) => provider.authMethods.includes("oauth"))
        .map((provider) => provider.id)
        .sort(),
    ).toEqual(Object.keys(urls).sort())
    expect(new Set(catalog.map((provider) => provider.id)).size).toBe(catalog.length)
    expect(catalog.some((provider) => provider.id === "radius")).toBe(false)
    for (const id of ["openai", "openrouter"]) {
      expect(catalog.find((provider) => provider.id === id)?.authMethods).toEqual(["api_key"])
    }
    for (const provider of catalog) {
      const sdk = getBuiltinProvider(provider.id)
      expect(sdk).toBeDefined()
      expect(provider.authMethods).toEqual(providerAuthMethods(sdk as Provider))
      for (const model of provider.models) {
        const full = getBuiltinModel(provider.id, model.id)
        expect(full).toBe(sdk?.getModels().find((candidate) => candidate.id === model.id))
        expect(model).toEqual({
          id: full?.id,
          name: full?.name,
          api: full?.api,
          baseUrl: full?.baseUrl,
          contextWindow: full?.contextWindow,
          maxTokens: full?.maxTokens,
        })
      }
    }
    expect(getBuiltinModel("missing", "missing")).toBeUndefined()
    expect(getBuiltinProvider("missing")).toBeUndefined()
  })

  it("validates provider-specific public HTTPS destinations", () => {
    for (const [id, url] of Object.entries(urls))
      expect(isAllowedAuthorizationUrl(id, url)).toBe(true)
    for (const url of [
      "http://auth.openai.com/",
      "https://localhost/",
      "https://127.0.0.1/",
      "https://auth.openai.com.evil.test/",
      "https://user:secret@auth.openai.com/",
      "https://auth.openai.com:444/",
      "https://auth.openai.com/#secret",
      " https://auth.openai.com/",
      "https://auth.openai.com/\n",
      "https://auth.openai.com\\@evil.test/",
    ]) {
      expect(isAllowedAuthorizationUrl("openai-codex", url)).toBe(false)
    }
    expect(isAllowedAuthorizationUrl("openrouter", "https://openrouter.ai/auth")).toBe(false)
  })
})

describe("SDK login bridge", () => {
  it.each(Object.keys(urls))("runs %s through the safe headless branch", async (id) => {
    let release: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const branches: string[] = []
    const provider = fixture(id, async (interaction) => {
      if (id === "openai-codex" || id === "anthropic") {
        const branch = await interaction.prompt({
          type: "select",
          message: "Login method",
          options: [
            { id: "browser", label: "Unsafe browser" },
            { id: id === "anthropic" ? "copy_code" : "device_code", label: "Headless" },
          ],
        })
        branches.push(branch)
        if (branch === "browser") throw new Error("unsafe browser branch")
      } else if (id === "github-copilot") {
        branches.push(
          await interaction.prompt({
            type: "text",
            message: "GitHub Enterprise URL/domain (blank for github.com)",
          }),
        )
      }
      if (id === "anthropic") {
        interaction.notify({ type: "auth_url", url: urls[id], instructions: "SDK instructions" })
        expect(
          await interaction.prompt({
            type: "manual_code",
            message: "Paste authorization code",
            placeholder: "code",
          }),
        ).toBe("private-user-answer")
      } else {
        interaction.notify({
          type: "device_code",
          userCode: "ABCD-EFGH",
          verificationUri: urls[id],
          expiresInSeconds: 600,
          intervalSeconds: 5,
        })
      }
      await ready
      return account
    })
    const { service, commit } = setup([provider])
    const started = service.start(owner, {
      providerId: id,
      authType: "oauth",
      confirmPolicyChanges: true,
    })
    await tick()
    let view = service.get(owner, started.id)
    if (id === "anthropic") {
      expect(view.status).toBe("prompt")
      expect(view.prompt?.type).toBe("manual_code")
      expect(view.event?.type).toBe("auth_url")
      const promptId = view.prompt?.id as string
      service.respond(owner, started.id, promptId, "private-user-answer")
      expect(() => service.respond(owner, started.id, promptId, "again")).toThrow("stale_prompt")
    } else {
      expect(view.event).toMatchObject({
        type: "device_code",
        openBrowserOnConfirm: false,
        copyCodeOnConfirm: false,
      })
    }
    expect(commit).not.toHaveBeenCalled()
    release?.()
    view = await settled(service, started.id)
    expect(view.status).toBe("complete")
    expect(view.savedProviderId).toBe(savedId)
    expect(commit).toHaveBeenCalledWith(
      { providerId: id, authType: "oauth", credential: account },
      expect.any(AbortSignal),
    )
    expect(JSON.stringify(view)).not.toMatch(/private-|opaque-session|credential|refresh/)
    if (id === "openai-codex") expect(branches).toEqual(["device_code"])
    if (id === "anthropic") expect(branches).toEqual(["copy_code"])
    if (id === "github-copilot") expect(branches).toEqual([""])
  })

  it("uses the installed SDK API-key login, stages updates, and retains the saved entry identity", async () => {
    const { service, commit } = setup()
    const view = service.start(owner, {
      providerId: "anthropic",
      authType: "api_key",
      savedProviderId: savedId,
      expectedGeneration: generation,
    })
    expect(view.prompt?.type).toBe("secret")
    expect(commit).not.toHaveBeenCalled()
    service.respond(owner, view.id, view.prompt?.id as string, "fixture-only-key")
    expect((await settled(service, view.id)).status).toBe("complete")
    expect(commit).toHaveBeenCalledWith(
      {
        providerId: "anthropic",
        authType: "api_key",
        savedProviderId: savedId,
        expectedGeneration: generation,
        credential: { type: "api_key", key: "fixture-only-key" },
      },
      expect.any(AbortSignal),
    )
  })

  it("requires explicit Copilot policy consent before SDK invocation", () => {
    const login = vi.fn(async () => account)
    const { service } = setup([fixture("github-copilot", login)])
    for (const confirmPolicyChanges of [undefined, false]) {
      expect(() =>
        service.start(owner, {
          providerId: "github-copilot",
          authType: "oauth",
          confirmPolicyChanges,
        }),
      ).toThrow("consent_required")
    }
    expect(login).not.toHaveBeenCalled()
  })

  it("rejects unsupported callback flows and changed headless selectors", async () => {
    const { service } = setup()
    for (const id of ["openai", "openrouter", "radius"])
      expect(() => service.start(owner, { providerId: id, authType: "oauth" })).toThrow(
        "unsupported_method",
      )
    const injected = setup([
      fixture("openai-codex", async (interaction) => {
        await interaction.prompt({
          type: "select",
          message: "Changed flow",
          options: [{ id: "browser", label: "Browser" }],
        })
        return account
      }),
    ])
    const flow = injected.service.start(owner, { providerId: "openai-codex", authType: "oauth" })
    expect(await settled(injected.service, flow.id)).toMatchObject({
      status: "failed",
      error: "provider_auth_unsupported_prompt",
    })
    expect(injected.commit).not.toHaveBeenCalled()
  })

  it("isolates session owners and checks session invalidation before status and commit", async () => {
    let valid = true
    let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, commit } = setup(
      [
        fixture("meta", async () => {
          await wait
          return account
        }),
      ],
      (value) => valid && value === owner,
    )
    const flow = service.start(owner, { providerId: "meta", authType: "oauth" })
    expect(() => service.get("other-owner", flow.id)).toThrow("not_found")
    expect(() => service.cancel("other-owner", flow.id)).toThrow("not_found")
    expect(() => service.respond("other-owner", flow.id, "unknown", "value")).toThrow("not_found")
    valid = false
    expect(() => service.get(owner, flow.id)).toThrow("not_found")
    release?.()
    await tick()
    expect(commit).not.toHaveBeenCalled()
  })

  it.each(["cancel", "cancelOwner", "close"] as const)(
    "aborts on %s and never commits a late credential",
    async (operation) => {
      let interactionSignal: AbortSignal | undefined
      let release: (() => void) | undefined
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      const { service, commit } = setup([
        fixture("meta", async (interaction) => {
          interactionSignal = interaction.signal
          await wait
          return account
        }),
      ])
      const flow = service.start(owner, { providerId: "meta", authType: "oauth" })
      if (operation === "cancel") service.cancel(owner, flow.id)
      else if (operation === "cancelOwner") service.cancelOwner(owner)
      else service.close()
      expect(interactionSignal?.aborted).toBe(true)
      release?.()
      await tick()
      expect(commit).not.toHaveBeenCalled()
      if (operation !== "close") expect(service.get(owner, flow.id).status).toBe("cancelled")
    },
  )

  it("cancellation preserves existing credentials and rejects late prompt responses", async () => {
    const previous = { ...account }
    const { service, commit } = setup()
    const flow = service.start(owner, {
      providerId: "anthropic",
      authType: "api_key",
      savedProviderId: savedId,
      expectedGeneration: generation,
    })
    service.cancel(owner, flow.id)
    expect(() =>
      service.respond(owner, flow.id, flow.prompt?.id as string, "replacement-key"),
    ).toThrow("stale_prompt")
    await tick()
    expect(commit).not.toHaveBeenCalled()
    expect(previous).toEqual(account)
    expect(service.get(owner, flow.id)).toMatchObject({ status: "cancelled" })
  })

  it("honors prompt.signal races without accepting a stale answer", async () => {
    const promptAbort = new AbortController()
    const provider = getBuiltinProvider("anthropic") as Provider
    const { service, commit } = setup([
      {
        ...provider,
        auth: {
          apiKey: {
            name: "Fixture",
            resolve: async () => undefined,
            login: async (interaction) => {
              await interaction
                .prompt({ type: "secret", message: "First", signal: promptAbort.signal })
                .catch(() => {})
              const key = await interaction.prompt({ type: "secret", message: "Second" })
              return { type: "api_key", key }
            },
          },
        },
      },
    ])
    const first = service.start(owner, { providerId: "anthropic", authType: "api_key" })
    promptAbort.abort()
    await tick()
    const second = service.get(owner, first.id)
    expect(second.prompt?.id).not.toBe(first.prompt?.id)
    expect(() => service.respond(owner, first.id, first.prompt?.id as string, "late")).toThrow(
      "stale_prompt",
    )
    service.respond(owner, first.id, second.prompt?.id as string, "fixture-key")
    expect((await settled(service, first.id)).status).toBe("complete")
    expect(commit).toHaveBeenCalledOnce()
  })

  it("expires at 15 minutes, bounds owner flows, and does not commit late success", async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, commit } = setup([
      fixture("meta", async () => {
        await wait
        return account
      }),
    ])
    const flow = service.start(owner, { providerId: "meta", authType: "oauth" })
    for (let i = 0; i < 3; i++) service.start(owner, { providerId: "meta", authType: "oauth" })
    expect(() => service.start(owner, { providerId: "meta", authType: "oauth" })).toThrow(
      "capacity",
    )
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(service.get(owner, flow.id)).toMatchObject({
      status: "expired",
      error: "provider_auth_login_expired",
    })
    release?.()
    await tick()
    expect(commit).not.toHaveBeenCalled()
  })

  it.each([
    "Access denied private-token",
    "Device code expired private-token",
    "raw upstream secret private-token",
  ])("returns safe errors for %s", async (message) => {
    const { service, commit } = setup([
      fixture("meta", async () => {
        throw new Error(message)
      }),
    ])
    const flow = service.start(owner, { providerId: "meta", authType: "oauth" })
    const view = await settled(service, flow.id)
    expect(view.error).toBe(
      message.startsWith("Access")
        ? "provider_auth_access_denied"
        : message.startsWith("Device")
          ? "provider_auth_login_expired"
          : "provider_auth_login_failed",
    )
    expect(JSON.stringify(view)).not.toContain("private-token")
    expect(commit).not.toHaveBeenCalled()
  })

  it("rejects unsafe SDK URLs and does not return raw event text", async () => {
    const { service, commit } = setup([
      fixture("meta", async (interaction) => {
        interaction.notify({ type: "progress", message: "raw private-access" })
        await Promise.resolve()
        interaction.notify({ type: "auth_url", url: "https://evil.test/private-access" })
        return account
      }),
    ])
    const flow = service.start(owner, { providerId: "meta", authType: "oauth" })
    expect(flow.event).toEqual({ type: "progress", message: "Authentication in progress." })
    const view = await settled(service, flow.id)
    expect(view).toMatchObject({
      status: "failed",
      error: "provider_auth_unsafe_authorization_url",
    })
    expect(JSON.stringify(view)).not.toContain("private-access")
    expect(commit).not.toHaveBeenCalled()
  })

  it("disables SDK ambient API-key resolution and rejects empty staged credentials", async () => {
    const original = getBuiltinProvider("anthropic") as Provider
    const resolve = vi.fn(async () => {
      throw new Error("ambient resolution forbidden")
    })
    const { service, commit } = setup([
      {
        ...original,
        auth: {
          apiKey: {
            name: "Fixture",
            resolve,
            login: async () => ({ type: "api_key" }),
          },
        },
      },
    ])
    const flow = service.start(owner, { providerId: "anthropic", authType: "api_key" })
    expect(await settled(service, flow.id)).toMatchObject({
      status: "failed",
      error: "provider_auth_login_failed",
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()
  })

  it("rejects SDK OAuth host overrides before running Kimi login", () => {
    vi.stubEnv("KIMI_CODE_OAUTH_HOST", "https://evil.test")
    expect(() => assertProviderEnvironment("kimi-coding")).toThrow(
      "provider_auth_unsupported_environment",
    )
    expect(() => assertProviderEnvironment("meta")).not.toThrow()
    const login = vi.fn(async () => account)
    const { service } = setup([fixture("kimi-coding", login)])
    expect(() => service.start(owner, { providerId: "kimi-coding", authType: "oauth" })).toThrow(
      "unsupported_method",
    )
    expect(login).not.toHaveBeenCalled()
  })

  it("bounds the global flow count without creating listeners", () => {
    const { service } = setup([fixture("meta", async () => new Promise(() => {}))], () => true)
    for (let i = 0; i < 64; i++)
      service.start(`owner-${i}`, { providerId: "meta", authType: "oauth" })
    expect(() => service.start("extra-owner", { providerId: "meta", authType: "oauth" })).toThrow(
      "capacity",
    )
  })

  it("fails closed when an SDK implementation catches an unsafe URL error", async () => {
    const { service, commit } = setup([
      fixture("meta", async (interaction) => {
        try {
          interaction.notify({ type: "auth_url", url: "https://evil.test" })
        } catch {}
        return account
      }),
    ])
    const flow = service.start(owner, { providerId: "meta", authType: "oauth" })
    expect(await settled(service, flow.id)).toMatchObject({
      status: "failed",
      error: "provider_auth_unsafe_authorization_url",
    })
    expect(commit).not.toHaveBeenCalled()
  })

  it("bounds SDK event count and prompt metadata", async () => {
    const { service, commit } = setup([
      fixture("meta", async (interaction) => {
        for (let i = 0; i < 129; i++) interaction.notify({ type: "progress", message: "message" })
        return account
      }),
    ])
    const flow = service.start(owner, { providerId: "meta", authType: "oauth" })
    expect(await settled(service, flow.id)).toMatchObject({
      status: "failed",
      error: "provider_auth_login_failed",
    })
    expect(commit).not.toHaveBeenCalled()
    const original = getBuiltinProvider("anthropic") as Provider
    const injected = setup([
      {
        ...original,
        auth: {
          apiKey: {
            name: "Fixture",
            resolve: async () => undefined,
            login: async (interaction) => ({
              type: "api_key",
              key: await interaction.prompt({
                type: "secret",
                message: "m".repeat(10_000),
                placeholder: "p".repeat(10_000),
              }),
            }),
          },
        },
      },
    ])
    const prompt = injected.service.start(owner, { providerId: "anthropic", authType: "api_key" })
    expect(prompt.prompt?.message.length).toBe(300)
    expect(prompt.prompt?.placeholder?.length).toBe(200)
    expect(() =>
      injected.service.respond(owner, prompt.id, prompt.prompt?.id as string, "x".repeat(8193)),
    ).toThrow("invalid_response")
  })

  it("redacts earlier input responses from later SDK prompts", async () => {
    const original = getBuiltinProvider("anthropic") as Provider
    const { service } = setup([
      {
        ...original,
        auth: {
          apiKey: {
            name: "Fixture",
            resolve: async () => undefined,
            login: async (interaction) => {
              const key = await interaction.prompt({ type: "secret", message: "Key" })
              await interaction.prompt({
                type: "text",
                message: `Confirm ${key}`,
                placeholder: key,
              })
              return { type: "api_key", key }
            },
          },
        },
      },
    ])
    const flow = service.start(owner, { providerId: "anthropic", authType: "api_key" })
    service.respond(owner, flow.id, flow.prompt?.id as string, "input-response-secret")
    await tick()
    expect(JSON.stringify(service.get(owner, flow.id))).not.toContain("input-response-secret")
  })

  it("does not commit a device flow after the SDK device deadline", async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, commit } = setup([
      fixture("xai", async (interaction) => {
        interaction.notify({
          type: "device_code",
          userCode: "ABCD",
          verificationUri: urls.xai,
          expiresInSeconds: 2,
        })
        await wait
        return account
      }),
    ])
    const flow = service.start(owner, { providerId: "xai", authType: "oauth" })
    await vi.advanceTimersByTimeAsync(2000)
    release?.()
    expect(await settled(service, flow.id)).toMatchObject({ status: "expired" })
    expect(commit).not.toHaveBeenCalled()
  })
})
