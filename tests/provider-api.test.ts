import { mkdtempSync, rmSync } from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getBuiltinModel, getBuiltinProvider } from "../src/settings/providers.js"
import { SettingsStore } from "../src/settings/store.js"
import { AdminWeb } from "../src/web/admin.js"
import { Auth, type AuthOptions } from "../src/web/auth.js"

const origin = "https://reina.fixture.invalid"
const account: OAuthCredential = {
  type: "oauth",
  access: "private-fixture-access",
  refresh: "private-fixture-refresh",
  expires: Date.now() + 3_600_000,
}
let directory: string
let settings: SettingsStore
let admin: AdminWeb
let server: http.Server
let port: number
let options: AuthOptions
let cookie: string
let csrf: string
let changed: ReturnType<typeof vi.fn<() => void>>
const log = { info: vi.fn(), error: vi.fn() }

function provider() {
  const value = getBuiltinProvider("anthropic")
  if (!value?.auth.apiKey?.login || !value.auth.oauth) throw new Error("missing_fixture_provider")
  return value
}
function apiKeyMethod() {
  const method = provider().auth.apiKey
  if (!method?.login) throw new Error("missing_fixture_api_key")
  return method
}
function accountMethod() {
  const method = provider().auth.oauth
  if (!method) throw new Error("missing_fixture_oauth")
  return method
}
async function request(
  url: string,
  method = "GET",
  data?: unknown,
  headers: Record<string, string> = {},
) {
  const payload = data === undefined ? undefined : JSON.stringify(data)
  return new Promise<{
    status: number
    body: {
      id: string
      status: string
      savedProviderId: string
      prompt: { id: string }
      providers: { id: string; authMethods: string[] }[]
    }
    text: string
  }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: url,
        method,
        headers: {
          host: new URL(origin).host,
          cookie,
          origin,
          "x-csrf-token": csrf,
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
          ...headers,
        },
      },
      (res) => {
        let text = ""
        res.setEncoding("utf8").on("data", (chunk) => {
          text += chunk
        })
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {}, text }),
        )
      },
    )
    req.on("error", reject)
    req.end(payload)
  })
}
async function state(id: string, expected: string) {
  let response = await request(`/api/provider-setups/${id}`)
  await vi.waitFor(async () => {
    response = await request(`/api/provider-setups/${id}`)
    expect(response.body.status).toBe(expected)
  })
  return response
}
async function start(data: Record<string, unknown> = {}) {
  return request("/api/provider-setups", "POST", {
    providerId: "anthropic",
    authType: "api_key",
    ...data,
  })
}
function promptLogin() {
  return vi
    .spyOn(apiKeyMethod(), "login")
    .mockImplementation(async (interaction: ProviderAuthInteraction) => {
      const key = await interaction.prompt({ type: "secret", message: "Enter fixture key" })
      return { type: "api_key", key }
    })
}

beforeEach(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "reina-provider-api-"))
  settings = new SettingsStore(directory, "f".repeat(64))
  options = {
    origin,
    issuer: "https://identity.fixture.invalid",
    clientId: "fixture",
    clientSecret: "fixture",
    allowedGroups: ["reina-admins"],
  }
  const session = settings.createSession("same-fixture-subject", "Fixture", ["reina-admins"])
  cookie = `__Host-reina-session=${session.token}`
  csrf = session.csrfToken
  changed = vi.fn()
  log.info.mockClear()
  log.error.mockClear()
  admin = new AdminWeb(
    settings,
    new Auth(settings, options),
    origin,
    () => ({ state: "not_configured" }),
    changed,
    log,
  )
  server = http.createServer((req, res) => {
    void admin.handle(req, res).catch(() => {
      res.writeHead(500).end("{}")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("missing_fixture_listener")
  port = address.port
})
afterEach(async () => {
  admin.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.restoreAllMocks()
  expect(log.error).not.toHaveBeenCalled()
  settings.close()
  rmSync(directory, { recursive: true, force: true })
})

describe("provider setup admin API", () => {
  it("rejects anonymous, wrong-group, and forged-origin setup requests before SDK login", async () => {
    const login = promptLogin()
    expect((await request("/api/provider-setups", "POST", {}, { cookie: "" })).status).toBe(401)
    const denied = settings.createSession("same-fixture-subject", "Denied", ["user"])
    expect(
      (
        await request(
          "/api/provider-setups",
          "POST",
          {},
          { cookie: `__Host-reina-session=${denied.token}` },
        )
      ).status,
    ).toBe(401)
    const invalidHeaders: Record<string, string>[] = [
      { "x-csrf-token": "" },
      { origin: "https://other.invalid" },
      { "x-csrf-token": "wrong" },
    ]
    for (const headers of invalidHeaders) expect((await startWithHeaders(headers)).status).toBe(403)
    expect(login).not.toHaveBeenCalled()
  })

  it("lists methods without resolving credentials or starting account setup", async () => {
    const login = vi.spyOn(accountMethod(), "login")
    const response = await request("/api/catalog")
    expect(response.status).toBe(200)
    expect(
      response.body.providers.find((item: { id: string }) => item.id === "openai-codex")
        ?.authMethods,
    ).toEqual(["oauth"])
    expect(login).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })

  it("rejects unsupported account methods and client-supplied generation values", async () => {
    expect((await start({ providerId: "openai", authType: "oauth" })).status).toBe(400)
    expect((await start({ providerId: "openrouter", authType: "oauth" })).status).toBe(400)
    expect((await start({ expectedGeneration: "forged-generation" })).status).toBe(400)
  })

  it("saves an SDK credential after the owner responds, without auto-selecting a model", async () => {
    promptLogin()
    const flow = await start()
    const waiting = await state(flow.body.id, "prompt")
    expect(changed).not.toHaveBeenCalled()
    const response = await request(`/api/provider-setups/${flow.body.id}/responses`, "POST", {
      promptId: waiting.body.prompt.id,
      value: "private-fixture-key",
    })
    expect(response.status).toBe(200)
    const complete = await state(flow.body.id, "complete")
    expect(complete.body.savedProviderId).toBe(settings.providers()[0].id)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(settings.selectedModelId()).toBeNull()
    expect(settings.providers()[0]).toMatchObject({
      sdkProviderId: "anthropic",
      authType: "api_key",
      hasCredential: true,
    })
    for (const url of ["/api/settings", `/api/provider-setups/${flow.body.id}`]) {
      const result = await request(url)
      expect(result.text).not.toContain("private-fixture-key")
      expect(result.text).not.toContain("encrypted_key")
    }
    const replay = await request(`/api/provider-setups/${flow.body.id}/responses`, "POST", {
      promptId: waiting.body.prompt.id,
      value: "replayed",
    })
    expect(replay.status).toBe(409)
  })

  it("does not let another session with the same subject read, answer or cancel a flow", async () => {
    promptLogin()
    const flow = await start()
    const waiting = await state(flow.body.id, "prompt")
    const other = settings.createSession("same-fixture-subject", "Other session", ["reina-admins"])
    const headers = {
      cookie: `__Host-reina-session=${other.token}`,
      "x-csrf-token": other.csrfToken,
    }
    expect(
      (await request(`/api/provider-setups/${flow.body.id}`, "GET", undefined, headers)).status,
    ).toBe(404)
    expect(
      (
        await request(
          `/api/provider-setups/${flow.body.id}/responses`,
          "POST",
          { promptId: waiting.body.prompt.id, value: "stolen" },
          headers,
        )
      ).status,
    ).toBe(404)
    expect(
      (await request(`/api/provider-setups/${flow.body.id}`, "DELETE", undefined, headers)).status,
    ).toBe(404)
    expect((await request(`/api/provider-setups/${flow.body.id}`)).body.status).toBe("prompt")
  })

  it("rejects stale prompt and missing mutation protection without consuming a good prompt", async () => {
    promptLogin()
    const flow = await start()
    const waiting = await state(flow.body.id, "prompt")
    const url = `/api/provider-setups/${flow.body.id}/responses`
    expect(
      (
        await request(url, "POST", {
          promptId: "00000000-0000-4000-8000-000000000000",
          value: "wrong",
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await request(
          url,
          "POST",
          { promptId: waiting.body.prompt.id, value: "wrong" },
          { "x-csrf-token": "" },
        )
      ).status,
    ).toBe(403)
    expect((await request(`/api/provider-setups/${flow.body.id}`)).body.status).toBe("prompt")
  })

  it("keeps the prior account, models, and selection on cancelled credential update", async () => {
    const id = settings.saveBuiltinCredential("anthropic", account)
    const native = provider()
      .getModels()
      .find((item) => getBuiltinModel("anthropic", item.id))
    if (!native) throw new Error("missing_fixture_model")
    const modelId = settings.saveModel(id, {
      modelId: native.id,
      name: native.name,
      contextWindow: native.contextWindow,
      maxTokens: 4096,
    })
    settings.selectModel(modelId)
    promptLogin()
    const flow = await start({ savedProviderId: id })
    await state(flow.body.id, "prompt")
    expect((await request(`/api/provider-setups/${flow.body.id}`, "DELETE")).status).toBe(200)
    expect(settings.credentialState(id)?.credential).toMatchObject({ access: account.access })
    expect(settings.selectedModelId()).toBe(modelId)
    expect(changed).not.toHaveBeenCalled()
  })

  it("prevents a late login from overwriting a newer saved credential", async () => {
    const id = settings.saveBuiltinCredential("anthropic", account)
    promptLogin()
    const flow = await start({ savedProviderId: id })
    const waiting = await state(flow.body.id, "prompt")
    settings.saveBuiltinCredential(
      "anthropic",
      { ...account, access: "newer-login" },
      id,
      settings.credentialState(id)?.generation,
    )
    await request(`/api/provider-setups/${flow.body.id}/responses`, "POST", {
      promptId: waiting.body.prompt.id,
      value: "old-prompt-key",
    })
    const failure = await state(flow.body.id, "failed")
    expect(failure.text).not.toContain("old-prompt-key")
    expect(settings.credentialState(id)?.credential).toMatchObject({ access: "newer-login" })
    expect(changed).not.toHaveBeenCalled()
  })

  it("aborts owner flows on logout and group-policy invalidation", async () => {
    promptLogin()
    const flow = await start()
    await state(flow.body.id, "prompt")
    expect((await request("/auth/logout", "POST")).status).toBe(200)
    expect(settings.providers()).toEqual([])
    expect(changed).not.toHaveBeenCalled()
    const session = settings.createSession("fixture", "Fixture", ["reina-admins"])
    cookie = `__Host-reina-session=${session.token}`
    csrf = session.csrfToken
    const pending = await start()
    const waiting = await state(pending.body.id, "prompt")
    options.allowedGroups = []
    expect(
      (
        await request(`/api/provider-setups/${pending.body.id}/responses`, "POST", {
          promptId: waiting.body.prompt.id,
          value: "denied",
        })
      ).status,
    ).toBe(401)
    expect(settings.providers()).toEqual([])
  })

  it("expires setup without changing a stored credential", async () => {
    promptLogin()
    const flow = await start()
    await state(flow.body.id, "prompt")
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 15 * 60 * 1000 + 1000)
    expect((await request(`/api/provider-setups/${flow.body.id}`)).body.status).toBe("expired")
    expect(settings.providers()).toEqual([])
  })

  it("removes only the credential, stops dispatch, and clears an affected selection", async () => {
    const id = settings.saveBuiltinCredential("anthropic", account)
    const native = provider()
      .getModels()
      .find((item) => getBuiltinModel("anthropic", item.id))
    if (!native) throw new Error("missing_fixture_model")
    const modelId = settings.saveModel(id, {
      modelId: native.id,
      name: native.name,
      contextWindow: native.contextWindow,
      maxTokens: 4096,
    })
    settings.selectModel(modelId)
    expect((await request(`/api/providers/${id}/credential`, "DELETE")).status).toBe(200)
    expect(settings.selectedModelId()).toBeNull()
    expect(settings.providers()[0]).toMatchObject({
      hasCredential: false,
      sdkProviderId: "anthropic",
    })
    expect(settings.providers()[0].models).toHaveLength(1)
    expect(changed).toHaveBeenCalledTimes(1)
  })
})
function startWithHeaders(headers: Record<string, string>) {
  return request(
    "/api/provider-setups",
    "POST",
    { providerId: "anthropic", authType: "api_key" },
    headers,
  )
}
