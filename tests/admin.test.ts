import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import http, { type Server } from "node:http"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { httpServer } from "../src/app.js"
import type { DispatchStatus } from "../src/settings/dispatch.js"
import type { SavedProvider } from "../src/settings/schema.js"
import { SettingsStore } from "../src/settings/store.js"
import { AdminWeb } from "../src/web/admin.js"
import { Auth } from "../src/web/auth.js"

const origin = "https://reina.narumi.dev"
const apiKey = "fixture-api-key-private-value"
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
const provider = {
  name: "Example",
  api: "openai-completions",
  baseUrl: "https://model.example/v1",
  apiKey,
}
const model = {
  modelId: "example/model",
  name: "Example model",
  contextWindow: 128000,
  maxTokens: 4096,
}
const webhookSecret = "fixture-webhook-secret-never-returned"
const runtimeSettings = {
  appId: 123,
  webhookSecret,
  repository: { owner: "example", name: "project", id: 456, installationId: 789 },
  image: `sha256:${"d".repeat(64)}`,
  allowedPaths: ["README.md", "docs/**", "src/**", "tests/**"],
  forbiddenPaths: ["src/security/**", "src/deployment/**"],
  commands: [["npm", "run", "ci"]],
  scanIntervalMs: 900_000,
  maxIssuesPerScan: 10,
  maxConcurrentJobs: 1,
  agentTimeoutMs: 600_000,
  maxChangedFiles: 10,
  maxPatchBytes: 65_536,
}
let directory: string
let store: SettingsStore
let server: Server
let port: number
let token: string
let csrf: string
let auth: Auth
const changed = vi.fn()
const log = { info: vi.fn(), error: vi.fn() }

async function request(
  route: string,
  method = "GET",
  data?: unknown,
  options: { anonymous?: boolean; headers?: Record<string, string>; raw?: boolean } = {},
) {
  const payload = data === undefined ? undefined : options.raw ? String(data) : JSON.stringify(data)
  return await new Promise<{
    status: number
    headers: http.IncomingHttpHeaders
    text: string
    json: () => {
      id: string
      error: string
      selectedModelId: string | null
      providers: SavedProvider[]
      github: { configured: boolean; fingerprint: string }
      runtimeSettings: DispatchStatus | null
    }
  }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          host: new URL(origin).host,
          ...(!options.anonymous ? { cookie: `__Host-reina-session=${token}` } : {}),
          ...(method !== "GET"
            ? { origin, "x-csrf-token": csrf, "content-type": "application/json" }
            : {}),
          ...(payload !== undefined
            ? { "content-length": String(Buffer.byteLength(payload)) }
            : {}),
          ...options.headers,
        },
      },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk) => {
          text += chunk
        })
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          }),
        )
      },
    )
    req.on("error", reject)
    req.end(payload)
  })
}

beforeEach(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), "reina-admin-test-"))
  store = new SettingsStore(directory, "a".repeat(64))
  const session = store.createSession("admin-subject", "Test Admin", ["reina-admins"])
  token = session.token
  csrf = session.csrfToken
  auth = new Auth(store, {
    origin,
    issuer: "https://id.example",
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    allowedGroups: ["reina-admins"],
  })
  const admin = new AdminWeb(
    store,
    auth,
    origin,
    () => ({ state: "not_configured", reason: "configure_model" }),
    changed,
    log,
  )
  server = httpServer(() => undefined, log, admin)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as import("node:net").AddressInfo).port
  changed.mockClear()
  log.info.mockClear()
  log.error.mockClear()
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  vi.restoreAllMocks()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

describe("runtime settings API", () => {
  it("starts unconfigured and returns safe settings after an explicit save", async () => {
    expect((await request("/api/settings")).json().runtimeSettings).toBeNull()
    const saved = await request("/api/runtime/settings", "POST", runtimeSettings)
    expect(saved.status).toBe(200)
    expect(saved.text).not.toContain(webhookSecret)
    expect(changed).toHaveBeenCalledExactlyOnceWith()
    const response = await request("/api/settings")
    const { webhookSecret: _secret, ...publicSettings } = runtimeSettings
    expect(response.json().runtimeSettings).toEqual({
      ...publicSettings,
      webhookSecretConfigured: true,
    })
    expect(response.text).not.toContain(webhookSecret)
    expect(response.text).not.toContain('"webhookSecret":')
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(store.dispatchSettings()?.webhookSecret).toBe(webhookSecret)
  })

  it("accepts legacy-sized verification argv with the runtime record overhead", async () => {
    const commands = [["npm", ...Array.from({ length: 16 }, () => "x".repeat(4090))]]
    expect(JSON.stringify(commands).length).toBeLessThanOrEqual(65_536)
    const input = { ...runtimeSettings, commands }
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(65_536)
    const response = await request("/api/runtime/settings", "POST", input)
    expect(response.status).toBe(200)
    expect(store.dispatchSettings()?.commands).toEqual(commands)
    expect(changed).toHaveBeenCalledExactlyOnceWith()
  })

  it("preserves a saved webhook secret when the update omits it", async () => {
    await request("/api/runtime/settings", "POST", runtimeSettings)
    const { webhookSecret: _secret, ...update } = runtimeSettings
    const saved = await request("/api/runtime/settings", "POST", {
      ...update,
      scanIntervalMs: 60_000,
    })
    expect(saved.status).toBe(200)
    expect(store.dispatchSettings()).toMatchObject({ webhookSecret, scanIntervalMs: 60_000 })
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it("requires a webhook secret on the first save without starting dispatch", async () => {
    const { webhookSecret: _secret, ...input } = runtimeSettings
    const response = await request("/api/runtime/settings", "POST", input)
    expect(response.status).toBe(400)
    expect(response.json()).toMatchObject({ error: "invalid_input", fields: ["webhookSecret"] })
    expect(store.dispatchStatus()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })

  it("requires an allowed session, exact Origin, and CSRF for runtime changes", async () => {
    for (const options of [
      { anonymous: true },
      { headers: { origin: "https://evil.example" } },
      { headers: { "x-csrf-token": "wrong" } },
    ]) {
      const response = await request("/api/runtime/settings", "POST", runtimeSettings, options)
      expect(response.status).toBe(options.anonymous ? 401 : 403)
    }
    const denied = store.createSession("denied-subject", "Denied", ["user"])
    token = denied.token
    csrf = denied.csrfToken
    expect((await request("/api/runtime/settings", "POST", runtimeSettings)).status).toBe(401)
    expect(store.dispatchStatus()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })

  it("rejects unsafe settings with dotted field names and preserves the saved snapshot", async () => {
    await request("/api/runtime/settings", "POST", runtimeSettings)
    changed.mockClear()
    const response = await request("/api/runtime/settings", "POST", {
      ...runtimeSettings,
      repository: { ...runtimeSettings.repository, id: 0 },
      image: "worker:latest",
      forbiddenPaths: [],
      commands: [["npm\nprivate-input"]],
    })
    expect(response.status).toBe(400)
    expect(response.json()).toMatchObject({
      error: "invalid_input",
      fields: expect.arrayContaining(["repository.id", "image", "forbiddenPaths", "commands.0.0"]),
    })
    expect(response.text).not.toContain(webhookSecret)
    expect(response.text).not.toContain("private-input")
    expect(store.dispatchSettings()).toEqual(runtimeSettings)
    expect(changed).not.toHaveBeenCalled()
  })

  it("rejects unsupported requests and logs storage failures without secrets", async () => {
    expect((await request("/api/runtime/settings", "PUT", runtimeSettings)).status).toBe(404)
    expect(
      (
        await request("/api/runtime/settings", "POST", runtimeSettings, {
          headers: { "content-type": "text/plain" },
        })
      ).status,
    ).toBe(415)
    expect((await request("/api/runtime/settings", "POST", "{broken", { raw: true })).status).toBe(
      400,
    )
    expect(
      (
        await request("/api/runtime/settings", "POST", {
          ...runtimeSettings,
          webhookSecret: "x".repeat(512 * 1024),
        })
      ).status,
    ).toBe(413)
    vi.spyOn(store, "saveDispatchSettings").mockImplementation(() => {
      throw new Error(webhookSecret)
    })
    const failed = await request("/api/runtime/settings", "POST", runtimeSettings)
    expect(failed.status).toBe(500)
    expect(failed.text).not.toContain(webhookSecret)
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(webhookSecret)
    expect(log.error).toHaveBeenCalledWith({
      event: "http_request_failed",
      reason: "settings_unavailable",
      method: "POST",
      route: "/api/runtime/settings",
      status: 500,
    })
    expect(changed).not.toHaveBeenCalled()
  })
})

describe("admin web boundary", () => {
  it("requires login for the page/settings/catalog but serves login and static assets", async () => {
    const home = await request("/", "GET", undefined, { anonymous: true })
    expect(home.status).toBe(303)
    expect(home.headers.location).toBe("/login")
    expect((await request("/api/settings", "GET", undefined, { anonymous: true })).status).toBe(401)
    expect((await request("/api/catalog", "GET", undefined, { anonymous: true })).status).toBe(401)
    const login = await request("/login", "GET", undefined, { anonymous: true })
    expect(login.status).toBe(200)
    expect(login.text).toContain("Pocket ID")
    expect((await request("/assets/app.js", "GET", undefined, { anonymous: true })).status).toBe(
      200,
    )
    expect((await request("/assets/style.css", "GET", undefined, { anonymous: true })).status).toBe(
      200,
    )
    expect(
      (await request("/assets/../../.env", "GET", undefined, { anonymous: true })).status,
    ).toBe(404)
  })

  it("denies admin APIs when the session has no allowed group membership", async () => {
    const denied = store.createSession("admin-subject", "Test Admin", ["user"])
    token = denied.token
    csrf = denied.csrfToken
    expect((await request("/api/settings")).status).toBe(401)
    expect((await request("/api/providers", "POST", provider)).status).toBe(401)
    expect(store.providers()).toEqual([])
    expect(changed).not.toHaveBeenCalled()
  })

  it("serves authenticated HTML and empty settings with strict headers", async () => {
    const response = await request("/")
    expect(response.status).toBe(200)
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'")
    expect(response.headers["content-security-policy"]).not.toContain("unsafe-inline")
    expect(response.headers["cache-control"]).toBe("no-store")
    expect(response.headers["referrer-policy"]).toBe("no-referrer")
    const settings = (await request("/api/settings")).json()
    expect(settings).toMatchObject({
      providers: [],
      selectedModelId: null,
      github: { configured: false },
      user: { name: "Test Admin" },
      csrfToken: csrf,
    })
  })

  it("checks exact Host and rejects forged forwarded headers", async () => {
    expect(
      (
        await request("/api/settings", "GET", undefined, {
          headers: { host: "evil.example", "x-forwarded-host": "reina.narumi.dev" },
        })
      ).status,
    ).toBe(421)
    expect(
      (
        await request("/api/providers", "POST", provider, {
          headers: { origin: "https://evil.example", "x-forwarded-host": "reina.narumi.dev" },
        })
      ).status,
    ).toBe(403)
    expect(store.providers()).toEqual([])
  })

  it("requires session, Origin and CSRF for mutations", async () => {
    const cases: NonNullable<Parameters<typeof request>[3]>[] = [
      { anonymous: true },
      { headers: { origin: "https://evil.example" } },
      { headers: { "x-csrf-token": "wrong" } },
    ]
    for (const options of cases) {
      expect((await request("/api/providers", "POST", provider, options)).status).toBe(
        options.anonymous ? 401 : 403,
      )
    }
    expect(changed).not.toHaveBeenCalled()
  })

  it("creates/updates providers and models, selects explicitly, and returns no saved secrets", async () => {
    const created = await request("/api/providers", "POST", provider)
    expect(created.status).toBe(200)
    const id = created.json().id
    expect((await request("/api/providers", "POST", { ...provider, name: "Second" })).status).toBe(
      200,
    )
    const savedModel = await request(`/api/providers/${id}/models`, "POST", model)
    expect(savedModel.status).toBe(200)
    const mid = savedModel.json().id
    expect(store.selectedModelId()).toBeNull()
    expect((await request("/api/selection", "PUT", { modelId: mid })).status).toBe(200)
    expect((await request(`/api/models/${mid}`, "PUT", { ...model, name: "Renamed" })).status).toBe(
      200,
    )
    expect(
      (
        await request(`/api/providers/${id}`, "PUT", {
          name: "Updated",
          api: provider.api,
          baseUrl: provider.baseUrl,
        })
      ).status,
    ).toBe(200)
    const inventory = await request("/api/settings")
    expect(inventory.text).not.toContain(apiKey)
    expect(inventory.json().selectedModelId).toBe(mid)
    expect(
      inventory.json().providers.find((value: { id: string }) => value.id === id)?.hasApiKey,
    ).toBe(true)
    expect((await request(`/api/models/${mid}`, "DELETE")).status).toBe(200)
    expect(store.selectedModelId()).toBeNull()
    expect((await request(`/api/providers/${id}`, "DELETE")).status).toBe(200)
    expect(changed).toHaveBeenCalledTimes(8)
  })

  it("rejects invalid input without echoing keys or arbitrary fields", async () => {
    const response = await request("/api/providers", "POST", {
      ...provider,
      baseUrl: "http://internal.invalid",
      attacker: "secret",
    })
    expect(response.status).toBe(400)
    expect(response.json()).toMatchObject({
      error: "invalid_input",
      fields: expect.arrayContaining(["baseUrl"]),
    })
    expect(response.text).not.toContain(apiKey)
    expect(response.text).not.toContain("internal.invalid")
    expect(
      (
        await request("/api/providers", "POST", provider, {
          headers: { "content-type": "text/plain" },
        })
      ).status,
    ).toBe(415)
    expect((await request("/api/providers", "POST", "invalid-json", { raw: true })).status).toBe(
      400,
    )
    expect(changed).not.toHaveBeenCalled()
  })

  it("bounds JSON bodies and rejects private endpoints", async () => {
    expect(
      (await request("/api/providers", "POST", { ...provider, apiKey: "x".repeat(70000) })).status,
    ).toBe(413)
    expect(
      (await request("/api/providers", "POST", { ...provider, baseUrl: "https://127.0.0.1/v1" }))
        .status,
    ).toBe(400)
  })

  it("uploads and replaces a PEM as encrypted secret metadata only", async () => {
    const upload = await request("/api/github/private-key", "POST", pem, {
      raw: true,
      headers: { "content-type": "application/x-pem-file" },
    })
    expect(upload.status).toBe(200)
    expect(upload.text).not.toContain("PRIVATE KEY")
    const inventory = await request("/api/settings")
    expect(inventory.json().github).toMatchObject({
      configured: true,
      fingerprint: expect.stringMatching(/^SHA256:/),
    })
    expect(inventory.text).not.toContain(pem.slice(50, 100))
    expect((await request("/api/github/private-key")).status).toBe(404)
    expect((await request("/api/github/private-key", "DELETE")).status).toBe(200)
    expect(store.githubStatus().configured).toBe(false)
  })

  it("rejects invalid/oversized PEM uploads without replacing the existing key", async () => {
    store.savePrivateKey(pem)
    const fingerprint = store.githubStatus().fingerprint
    const invalid = await request("/api/github/private-key", "POST", "private-input-invalid", {
      raw: true,
      headers: { "content-type": "application/x-pem-file" },
    })
    expect(invalid.status).toBe(400)
    expect(invalid.json().error).toBe("invalid_private_key")
    expect(invalid.text).not.toContain("private-input-invalid")
    expect(
      (
        await request("/api/github/private-key", "POST", "x".repeat(32769), {
          raw: true,
          headers: { "content-type": "application/x-pem-file" },
        })
      ).status,
    ).toBe(413)
    expect(store.githubStatus().fingerprint).toBe(fingerprint)
    expect(changed).not.toHaveBeenCalled()
  })

  it("logs one safe error when settings persistence fails", async () => {
    const secret = "private-database-error-with-credentials"
    vi.spyOn(store, "saveProvider").mockImplementationOnce(() => {
      throw new Error(secret)
    })
    const response = await request("/api/providers?code=private-oauth-code", "POST", provider, {
      headers: { authorization: "Bearer private-header-value" },
    })
    expect(response.status).toBe(500)
    expect(response.json()).toEqual({ error: "settings_unavailable" })
    expect(changed).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledExactlyOnceWith({
      event: "http_request_failed",
      reason: "settings_unavailable",
      method: "POST",
      route: "/api/providers",
      status: 500,
    })
    const logs = JSON.stringify(log.error.mock.calls)
    for (const value of [secret, apiKey, token, csrf, "private-oauth-code", "private-header-value"])
      expect(logs).not.toContain(value)
  })

  it("logs one safe error for an uncaught settings handler failure", async () => {
    vi.spyOn(store, "providers").mockImplementationOnce(() => {
      throw new Error("private-settings-read-error")
    })
    expect((await request("/api/settings?state=private-state")).status).toBe(503)
    expect(log.error).toHaveBeenCalledExactlyOnceWith({
      event: "http_request_failed",
      reason: "request_handler_failed",
      method: "GET",
      route: "/api/settings",
      status: 503,
    })
  })

  it("logs the actual response status when a handler fails after headers are sent", async () => {
    vi.spyOn(auth, "handle").mockImplementationOnce(async (_req, res) => {
      res.writeHead(200)
      res.write("partial response")
      throw new Error("private-handler-error")
    })
    const response = await request("/auth/callback?code=private-code")
    expect(response.status).toBe(200)
    expect(response.text).toBe("partial response")
    expect(log.error).toHaveBeenCalledExactlyOnceWith({
      event: "http_request_failed",
      reason: "request_handler_failed",
      method: "GET",
      route: "/auth/callback",
      status: 200,
    })
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("private-")
  })

  it.each([
    ["/auth/callback?code=private-code&state=private-state", "GET", "/auth/callback", "GET"],
    ["/private-unknown-path?secret=private-query", "PURGE", "unknown", "unknown"],
  ])(
    "does not log raw request data on uncaught failure: %s",
    async (url, method, route, safeMethod) => {
      vi.spyOn(auth, "handle").mockRejectedValueOnce(new Error("private-error-message"))
      const response = await request(url, method, "private-body", {
        headers: { authorization: "Bearer private-header", "x-private": "private-header-data" },
      })
      expect(response.status).toBe(503)
      expect(log.error).toHaveBeenCalledExactlyOnceWith({
        event: "http_request_failed",
        reason: "request_handler_failed",
        method: safeMethod,
        route,
        status: 503,
      })
      const logs = JSON.stringify(log.error.mock.calls)
      for (const value of ["private-", token, csrf]) expect(logs).not.toContain(value)
    },
  )

  it("does not log errors for expected auth, validation, routing, health or standby responses", async () => {
    expect((await request("/api/settings", "GET", undefined, { anonymous: true })).status).toBe(401)
    expect(
      (
        await request("/api/providers", "POST", provider, {
          headers: { "x-csrf-token": "wrong" },
        })
      ).status,
    ).toBe(403)
    expect((await request("/api/providers", "POST", {})).status).toBe(400)
    expect(
      (
        await request("/api/github/private-key", "POST", "invalid-key", {
          raw: true,
          headers: { "content-type": "application/x-pem-file" },
        })
      ).status,
    ).toBe(400)
    expect((await request("/api/unknown")).status).toBe(404)
    expect((await request("/healthz")).status).toBe(200)
    expect((await request("/api/github/webhooks", "POST", {}, { anonymous: true })).status).toBe(
      503,
    )
    expect(log.error).not.toHaveBeenCalled()
  })

  it("retains HMAC webhook separation and HTTP health during incomplete setup", async () => {
    expect(
      (
        await request("/healthz", "GET", undefined, {
          anonymous: true,
          headers: { host: `127.0.0.1:${port}` },
        })
      ).text,
    ).toBe("ok")
    expect((await request("/api/github/webhooks", "POST", {}, { anonymous: true })).status).toBe(
      503,
    )
  })
})
