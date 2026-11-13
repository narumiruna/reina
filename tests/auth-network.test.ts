import { lookup } from "node:dns"
import {
  Agent,
  Dispatcher,
  getGlobalDispatcher,
  MockAgent,
  setGlobalDispatcher,
  fetch as undiciFetch,
} from "undici"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { installProviderAuthDispatcher, withProviderAuth } from "../src/settings/auth-network.js"
import { getBuiltinProvider } from "../src/settings/providers.js"

vi.mock("node:dns", () => ({ lookup: vi.fn() }))
const original = getGlobalDispatcher()
const nativeFetch = globalThis.fetch
const mock = new MockAgent()
const fallback = new MockAgent()
mock.disableNetConnect()
fallback.disableNetConnect()
const url = "https://auth.openai.com/oauth/token"
const endpoints: [string, string, string][] = [
  ["openai-codex", "POST", "https://auth.openai.com/api/accounts/deviceauth/usercode"],
  ["openai-codex", "POST", "https://auth.openai.com/api/accounts/deviceauth/token"],
  ["openai-codex", "POST", url],
  ["anthropic", "POST", "https://platform.claude.com/v1/oauth/token"],
  ["github-copilot", "POST", "https://github.com/login/device/code"],
  ["github-copilot", "POST", "https://github.com/login/oauth/access_token"],
  ["github-copilot", "GET", "https://api.github.com/copilot_internal/v2/token"],
  ...["individual", "business", "enterprise"].flatMap((account): [string, string, string][] => [
    ["github-copilot", "GET", `https://api.${account}.githubcopilot.com/models`],
    [
      "github-copilot",
      "POST",
      `https://api.${account}.githubcopilot.com/models/claude-sonnet-4.5/policy`,
    ],
  ]),
  ["kimi-coding", "POST", "https://auth.kimi.com/api/oauth/device_authorization"],
  ["kimi-coding", "POST", "https://auth.kimi.com/api/oauth/token"],
  ["meta", "POST", "https://auth.meta.com/oidc/device/authorization/"],
  ["meta", "POST", "https://auth.meta.com/oidc/device/token/"],
  ["meta", "POST", "https://api.meta.ai/muse-code/key"],
  ["xai", "POST", "https://auth.x.ai/oauth2/device/code"],
  ["xai", "POST", "https://auth.x.ai/oauth2/token"],
]

type Reply = {
  status?: number
  headers?: Record<string, string>
  chunks?: Buffer[]
  stall?: boolean
  queued?: boolean
  consume?: boolean
}
let reply: Reply | undefined
let aborted: Error | null = null
const safe = new Dispatcher()
safe.close = vi.fn(async () => {
  await mock.close()
}) as Dispatcher["close"]
safe.destroy = mock.destroy.bind(mock)
safe.dispatch = vi.fn((options, handler) => {
  if (!reply) return mock.dispatch(options, handler)
  const fixture = reply
  const controller = {
    aborted: false,
    paused: false,
    reason: null as Error | null,
    abort(error: Error) {
      this.aborted = true
      this.reason = error
      aborted = error
      handler.onResponseError?.(this, error)
    },
    pause() {
      this.paused = true
    },
    resume() {
      this.paused = false
    },
  }
  if (fixture.queued) return true
  handler.onRequestStart?.(controller, null)
  void (async () => {
    try {
      if (fixture.consume && options.body) {
        for await (const _chunk of options.body as AsyncIterable<Uint8Array>) {
          /* consume bounded body */
        }
      }
      if (fixture.stall || controller.aborted) return
      handler.onResponseStart?.(controller, fixture.status ?? 200, fixture.headers ?? {}, "OK")
      for (const chunk of fixture.chunks ?? [Buffer.from("{}")]) {
        if (!controller.aborted) handler.onResponseData?.(controller, chunk)
      }
      if (!controller.aborted) handler.onResponseEnd?.(controller, {})
    } catch (error) {
      handler.onResponseError?.(controller, error as Error)
    }
  })()
  return true
})
let wrapper: Dispatcher
beforeAll(() => {
  setGlobalDispatcher(fallback)
  wrapper = installProviderAuthDispatcher(safe)
})
afterEach(() => {
  reply = undefined
  aborted = null
  vi.mocked(safe.dispatch).mockClear()
  vi.useRealTimers()
})
afterAll(async () => {
  setGlobalDispatcher(original)
  if (!vi.mocked(safe.close).mock.calls.length) await wrapper.close()
  await fallback.close()
})
function intercept(destination: string, method: string, data: object = {}) {
  const target = new URL(destination)
  mock.get(target.origin).intercept({ path: target.pathname, method }).reply(200, data)
}
const post = (destination = url, init: RequestInit = {}) =>
  fetch(destination, { method: "POST", body: "fixture=credential", ...init })
const scoped = (action: () => Promise<unknown>) => withProviderAuth("openai-codex", action)

describe("SDK auth dispatcher boundary", () => {
  it("allows API-key-only provider prompts without permitting outbound authentication", async () => {
    await expect(withProviderAuth("openai", async () => "local-prompt-result")).resolves.toBe(
      "local-prompt-result",
    )
    await expect(
      withProviderAuth("openai", () => fetch("https://api.openai.com/v1/models")),
    ).rejects.toThrow()
  })

  it("uses native Node fetch and Undici 8 handlers for every exact SDK route", async () => {
    for (const [provider, method, destination] of endpoints) {
      intercept(destination, method, { ok: true })
      await withProviderAuth(provider, async () => {
        const response = await fetch(destination, {
          method,
          headers: { authorization: "Bearer fixture-only" },
          ...(method === "POST" ? { body: new URLSearchParams({ token: "fixture" }) } : {}),
        })
        expect(await response.json()).toEqual({ ok: true })
      })
    }
    intercept(url, "POST")
    await scoped(async () =>
      expect(await (await undiciFetch(url, { method: "POST", body: "fixture" })).json()).toEqual(
        {},
      ),
    )
    expect(globalThis.fetch).toBe(nativeFetch)
    expect(getGlobalDispatcher()).toBe(wrapper)
    expect(installProviderAuthDispatcher()).toBe(wrapper)
    expect(safe.dispatch).toHaveBeenCalledTimes(endpoints.length + 1)
  })

  it("preserves unscoped HTTP traffic, async concurrency and nested provider identity", async () => {
    fallback
      .get("http://unscoped.invalid")
      .intercept({ path: "/unrestricted?query=yes" })
      .reply(200, "fallback")
    intercept(url, "POST")
    intercept("https://platform.claude.com/v1/oauth/token", "POST")
    await Promise.all([
      scoped(async () => {
        await Promise.resolve()
        await withProviderAuth("anthropic", async () => {
          await expect(post()).rejects.toThrow()
          await post("https://platform.claude.com/v1/oauth/token")
        })
        await post()
      }),
      fetch("http://unscoped.invalid/unrestricted?query=yes").then(async (r) =>
        expect(await r.text()).toBe("fallback"),
      ),
    ])
    expect(safe.dispatch).toHaveBeenCalledTimes(2)
  })

  it("denies unknown providers and invalid host/path/method/port/query before credential dispatch", async () => {
    for (const destination of [
      "https://evil.invalid/oauth/token",
      "http://auth.openai.com/oauth/token",
      "https://auth.openai.com:444/oauth/token",
      "https://user:pass@auth.openai.com/oauth/token",
      `${url}?secret=fixture`,
      `${url}?`,
      `${url}/`,
      "https://127.0.0.1/oauth/token",
      "https://auth.openai.com.evil.invalid/oauth/token",
      "https://auth.openai.com/unknown",
    ])
      await expect(scoped(() => post(destination))).rejects.toThrow()
    for (const method of ["GET", "PUT", "DELETE", "HEAD", "OPTIONS"])
      await expect(scoped(() => fetch(url, { method }))).rejects.toThrow()
    await expect(withProviderAuth("openai", () => post())).rejects.toThrow()
    await expect(withProviderAuth("toString", () => post())).rejects.toThrow()
    await expect(withProviderAuth("anthropic", () => post())).rejects.toThrow()
    await scoped(async () => {
      for (const options of [
        { origin: "https://auth.openai.com#fragment", path: "/oauth/token" },
        { origin: "https://auth.openai.com", path: "/oauth/token#fragment" },
        { origin: "https://auth.openai.com", path: "/oauth/token", query: { token: "fixture" } },
      ])
        expect(() => wrapper.dispatch({ method: "POST", ...options }, {})).toThrow()
    })
    for (const path of [
      "/models/../policy",
      "/models/a%2Fb/policy",
      "/models/a/b/policy",
      "/models/.hidden/policy",
      "/models/a/policy?x=1",
    ])
      await expect(
        withProviderAuth("github-copilot", () =>
          post(`https://api.individual.githubcopilot.com${path}`),
        ),
      ).rejects.toThrow()
    expect(safe.dispatch).not.toHaveBeenCalled()
  })

  it("runs each SDK refresh through native fetch without replacing token exchange", async () => {
    const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`
    for (const [providerId, destination] of [
      ["openai-codex", url],
      ["anthropic", "https://platform.claude.com/v1/oauth/token"],
      ["kimi-coding", "https://auth.kimi.com/api/oauth/token"],
      ["meta", "https://api.meta.ai/muse-code/key"],
      ["xai", "https://auth.x.ai/oauth2/token"],
    ]) {
      const oauth = getBuiltinProvider(providerId)?.auth.oauth
      if (!oauth) throw new Error("missing_sdk_oauth")
      intercept(destination, "POST", {
        access_token: access,
        refresh_token: "fixture-rotated",
        expires_in: 3600,
        api_key: access,
      })
      const credential = await withProviderAuth(providerId, () =>
        oauth.refresh(
          { type: "oauth", access: "fixture-old", refresh: "fixture-refresh", expires: 0 },
          new AbortController().signal,
        ),
      )
      expect(credential.access).toBe(access)
    }
    expect(safe.dispatch).toHaveBeenCalledTimes(5)
  })

  it("runs the SDK Copilot device flow, model discovery and policy POST through the boundary", async () => {
    vi.useFakeTimers()
    const provider = getBuiltinProvider("github-copilot")
    const oauth = provider?.auth.oauth
    const model = provider?.getModels()[0]
    if (!oauth || !model) throw new Error("missing_sdk_copilot")
    intercept("https://github.com/login/device/code", "POST", {
      device_code: "fixture-device",
      user_code: "FIXTURE",
      verification_uri: "https://github.com/login/device",
      interval: 1,
      expires_in: 600,
    })
    intercept("https://github.com/login/oauth/access_token", "POST", {
      access_token: "fixture-github",
    })
    intercept("https://api.github.com/copilot_internal/v2/token", "GET", {
      token: "fixture;proxy-ep=proxy.business.githubcopilot.com;",
      expires_at: 2_000_000_000,
    })
    intercept("https://api.business.githubcopilot.com/models", "GET", {
      data: [{ id: model.id, model_picker_enabled: true, policy: { state: "unconfigured" } }],
    })
    intercept(`https://api.business.githubcopilot.com/models/${model.id}/policy`, "POST")
    const pending = withProviderAuth("github-copilot", () =>
      oauth.login({
        signal: new AbortController().signal,
        prompt: async () => "",
        notify: vi.fn(),
      }),
    )
    await vi.advanceTimersByTimeAsync(1001)
    expect((await pending).availableModelIds).toEqual([model.id])
    expect(safe.dispatch).toHaveBeenCalledTimes(5)
  })

  it("blocks malicious token.proxy-ep during the real SDK Copilot refresh", async () => {
    const oauth = getBuiltinProvider("github-copilot")?.auth.oauth
    if (!oauth) throw new Error("missing_sdk_oauth")
    intercept("https://api.github.com/copilot_internal/v2/token", "GET", {
      token: "fixture;proxy-ep=attacker.invalid;",
      expires_at: 2_000_000_000,
    })
    await expect(
      withProviderAuth("github-copilot", () =>
        oauth.refresh(
          {
            type: "oauth",
            access: "fixture-old",
            refresh: "fixture-refresh",
            expires: 0,
          },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow()
    expect(safe.dispatch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(safe.dispatch).mock.calls[0]?.[0].origin).toBe("https://api.github.com")
  })

  it.each([301, 302, 303, 307, 308])(
    "rejects %s before native fetch follows even an allowed target",
    async (status) => {
      reply = { status, headers: { location: url } }
      await expect(scoped(() => post())).rejects.toThrow()
      expect(aborted).toBeInstanceOf(Error)
      expect(safe.dispatch).toHaveBeenCalledTimes(1)
    },
  )

  it("bounds response bytes, headers and compressed responses before exposing them", async () => {
    const fixtures: Reply[] = [
      { headers: { "content-length": "1048577" } },
      { chunks: [Buffer.alloc(1024 * 1024), Buffer.from("x")] },
      { headers: { "x-huge": "x".repeat(16 * 1024) } },
      { headers: { "content-encoding": "gzip" }, chunks: [Buffer.from("compressed")] },
    ]
    for (const fixture of fixtures) {
      reply = fixture
      await expect(scoped(async () => (await post()).text())).rejects.toThrow()
      expect(aborted).toBeInstanceOf(Error)
    }
    reply = { chunks: [Buffer.alloc(1024 * 1024)] }
    expect(await scoped(async () => (await post()).text())).toHaveLength(1024 * 1024)
  })

  it("bounds outgoing headers and both known and streamed bodies", async () => {
    reply = { consume: true }
    for (const init of [
      { headers: { authorization: "x".repeat(16 * 1024) } },
      { body: "x".repeat(64 * 1024 + 1) },
    ])
      await expect(scoped(() => post(url, init))).rejects.toThrow()
    await scoped(async () => {
      expect(() =>
        wrapper.dispatch(
          {
            origin: "https://auth.openai.com",
            path: "/oauth/token",
            method: "POST",
            headers: ["host", "attacker.invalid"],
          },
          {},
        ),
      ).toThrow()
    })
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    })
    await expect(scoped(() => post(url, { body, duplex: "half" } as RequestInit))).rejects.toThrow()
    expect(await scoped(async () => (await post()).text())).toBe("{}")
    const options = vi.mocked(safe.dispatch).mock.lastCall?.[0]
    expect(options).toMatchObject({ headersTimeout: 15_000, bodyTimeout: 15_000 })
    expect(options?.headers).toContain("identity")
  })

  it.each([false, true])("enforces the total request deadline (queued=%s)", async (queued) => {
    vi.useFakeTimers()
    reply = { stall: true, queued }
    const pending = scoped(() => post())
    const assertion = expect(pending).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(30_001)
    await assertion
    if (!queued) expect(aborted?.message).toBe("provider_auth_network_timeout")
  })

  it("propagates caller abort and retains a bounded budget for 15-minute device polling", async () => {
    reply = { stall: true }
    const controller = new AbortController()
    const pending = scoped(() => post(url, { signal: controller.signal }))
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(aborted).toBeInstanceOf(Error)
    reply = {}
    await scoped(async () => {
      for (let index = 0; index < 2048; index++) await (await post()).text()
      await expect(post()).rejects.toThrow()
    })
    expect(safe.dispatch).toHaveBeenCalledTimes(2049)
  })

  it("expires the whole auth action after 15 minutes even while the SDK waits", async () => {
    vi.useFakeTimers()
    const pending = scoped(() => new Promise(() => {}))
    const assertion = expect(pending).rejects.toThrow("provider_auth_network_timeout")
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await assertion
    expect(safe.dispatch).not.toHaveBeenCalled()
  })

  it("rejects requests after scope expiry or completion, including detached async work", async () => {
    const clock = vi.spyOn(Date, "now")
    const start = Date.now()
    try {
      await scoped(async () => {
        clock.mockReturnValue(start + 15 * 60_000)
        await expect(post()).rejects.toThrow()
      })
    } finally {
      clock.mockRestore()
    }
    let release: (() => void) | undefined
    let detached: Promise<unknown> | undefined
    await scoped(async () => {
      detached = new Promise<void>((resolve) => {
        release = resolve
      }).then(() => post())
    })
    release?.()
    await expect(detached).rejects.toThrow()
    expect(safe.dispatch).not.toHaveBeenCalled()
  })

  it("uses publicLookup at the actual Agent connect boundary and rejects mixed private DNS", async () => {
    vi.resetModules()
    const isolated = await import("../src/settings/auth-network.js")
    vi.mocked(lookup).mockImplementation(((
      _host: unknown,
      _opts: unknown,
      callback: (error: null, addresses: unknown[]) => void,
    ) => {
      callback(null, [
        { address: "1.1.1.1", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ])
    }) as typeof lookup)
    const dispatchSpy = vi.spyOn(Agent.prototype, "dispatch")
    const network = isolated.installProviderAuthDispatcher()
    try {
      await expect(isolated.withProviderAuth("openai-codex", () => post())).rejects.toThrow()
      expect(lookup).toHaveBeenCalledWith(
        "auth.openai.com",
        { all: true, verbatim: true },
        expect.any(Function),
      )
      expect(dispatchSpy).toHaveBeenCalled()
    } finally {
      await network.close()
      dispatchSpy.mockRestore()
      setGlobalDispatcher(wrapper)
    }
  })

  it("closes only the auth transport and leaves unscoped traffic usable", async () => {
    await wrapper.close()
    expect(safe.close).toHaveBeenCalledTimes(1)
    fallback
      .get("http://unscoped.invalid")
      .intercept({ path: "/after-auth-close" })
      .reply(200, "fallback")
    expect(await (await fetch("http://unscoped.invalid/after-auth-close")).text()).toBe("fallback")
    expect(safe.dispatch).not.toHaveBeenCalled()
  })
})
