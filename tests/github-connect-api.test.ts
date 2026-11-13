import { generateKeyPairSync } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import http, { type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { httpServer } from "../src/app.js"
import type { GitHubConnectTransport } from "../src/github/connect.js"
import { SettingsStore } from "../src/settings/store.js"
import { AdminWeb } from "../src/web/admin.js"
import { Auth } from "../src/web/auth.js"
import { GitHubConnect } from "../src/web/github-connect.js"

const origin = "https://reina.narumi.dev"
const webhookSecret = "fixture-github-webhook-secret-never-returned"
const clientSecret = "fixture-github-client-secret-never-returned"
const userToken = "fixture-github-user-token-never-returned"
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
const app = { id: 123, clientId: "Iv-fixture-client", slug: "reina-fixture" }
const installation = { id: 789, appId: 123, suspended: false }
const repository = {
  id: 456,
  owner: "example",
  name: "project",
  fullName: "example/project",
  archived: false,
  disabled: false,
  permissions: { push: true },
}
let directory: string
let store: SettingsStore
let server: Server
let admin: AdminWeb
let port: number
let token: string
let csrf: string
let github: GitHubConnect
let transport: GitHubConnectTransport
const changed = vi.fn()
const log = { info: vi.fn(), error: vi.fn() }

async function request(
  path: string,
  method = "GET",
  data?: unknown,
  options: { anonymous?: boolean; headers?: Record<string, string> } = {},
) {
  const body = data === undefined ? undefined : JSON.stringify(data)
  return new Promise<{
    status: number
    headers: http.IncomingHttpHeaders
    text: string
    json: () => ReturnType<typeof JSON.parse>
  }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          host: new URL(origin).host,
          ...(!options.anonymous ? { cookie: `__Host-reina-session=${token}` } : {}),
          ...(method !== "GET"
            ? { origin, "x-csrf-token": csrf, "content-type": "application/json" }
            : {}),
          ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
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
    req.end(body)
  })
}
function configureApp() {
  store.saveGitHubAppSettings({
    appId: app.id,
    clientId: app.clientId,
    slug: app.slug,
    clientSecret,
    webhookSecret,
  })
}
async function start() {
  const response = await request("/api/github/connect", "POST")
  expect(response.status).toBe(200)
  const url = new URL(response.json().url)
  return { url, state: url.searchParams.get("state") as string }
}
async function authorize(state: string) {
  return request(`/auth/github/callback?code=fixture-code&state=${encodeURIComponent(state)}`)
}
function expectNoSecrets(value: string) {
  for (const secret of [webhookSecret, clientSecret, userToken, "BEGIN PRIVATE KEY"])
    expect(value).not.toContain(secret)
}

beforeEach(async () => {
  vi.clearAllMocks()
  directory = mkdtempSync(join(tmpdir(), "reina-github-connect-api-"))
  store = new SettingsStore(directory, "a".repeat(64))
  store.savePrivateKey(pem)
  const session = store.createSession("fixture-admin", "Fixture Admin", ["reina-admins"])
  token = session.token
  csrf = session.csrfToken
  const auth = new Auth(store, {
    origin,
    issuer: "https://identity.fixture.invalid",
    clientId: "fixture-oidc-client",
    clientSecret: "fixture-oidc-secret",
    allowedGroups: ["reina-admins"],
  })
  transport = {
    app: vi.fn(async () => app),
    exchange: vi.fn(async () => userToken),
    user: vi.fn(async () => ({ id: 99, login: "github-admin" })),
    installations: vi.fn(async () => [installation]),
    repositories: vi.fn(async () => [repository]),
    installation: vi.fn(async () => installation),
  }
  github = new GitHubConnect(
    store,
    auth,
    origin,
    { APP_ID: "123", WEBHOOK_SECRET: webhookSecret },
    transport,
  )
  admin = new AdminWeb(
    store,
    auth,
    origin,
    () => ({ state: "not_configured", reason: "configure_runtime" }),
    changed,
    log,
    undefined,
    github,
  )
  server = httpServer(() => undefined, log, admin)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as import("node:net").AddressInfo).port
})
afterEach(async () => {
  admin.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

describe("GitHub connection administrative boundary", () => {
  it("reports safe operator setup before runtime configuration exists", async () => {
    const response = await request("/api/settings")
    expect(response.status).toBe(200)
    expect(response.json()).toMatchObject({
      githubConnection: null,
      runtimeSettings: null,
      githubApp: {
        configured: false,
        appId: 123,
        clientSecretConfigured: false,
        webhookSecretConfigured: true,
        privateKeyConfigured: true,
        callbackUrl: `${origin}/auth/github/callback`,
        setupUrl: `${origin}/auth/github/setup`,
      },
    })
    expectNoSecrets(response.text)
    expect(transport.app).not.toHaveBeenCalled()
    expect(transport.exchange).not.toHaveBeenCalled()
  })

  it("requires an allowed session, exact Origin, and CSRF on every connection mutation", async () => {
    const deniedOptions: { anonymous?: boolean; headers?: Record<string, string> }[] = [
      { anonymous: true },
      { headers: { origin: "https://attacker.invalid" } },
      { headers: { "x-csrf-token": "wrong" } },
    ]
    for (const [path, body] of [
      ["/api/github/app", { appId: 123, clientSecret }],
      ["/api/github/connect", undefined],
      ["/api/github/connect/install", undefined],
      ["/api/github/connect/refresh", undefined],
      ["/api/github/connect/select", { repositoryId: 456 }],
      ["/api/github/connect/cancel", undefined],
    ] as const) {
      for (const options of deniedOptions) {
        const response = await request(path, "POST", body, options)
        expect(response.status).toBe(options.anonymous ? 401 : 403)
      }
    }
    expect(
      (await request("/api/github/connect", "GET", undefined, { anonymous: true })).status,
    ).toBe(401)
    const denied = store.createSession("denied", "Denied", ["user"])
    token = denied.token
    csrf = denied.csrfToken
    expect((await request("/api/github/connect", "POST")).status).toBe(401)
    expect(changed).not.toHaveBeenCalled()
    expect(transport.app).not.toHaveBeenCalled()
    expect(transport.exchange).not.toHaveBeenCalled()
  })

  it("saves service metadata derived from the App and imports matching legacy webhook settings", async () => {
    const response = await request("/api/github/app", "POST", { appId: 123, clientSecret })
    expect(response.status).toBe(200)
    expect(store.githubAppSettings()).toEqual({
      appId: 123,
      clientId: app.clientId,
      slug: app.slug,
      clientSecret,
      webhookSecret,
    })
    expect(changed).toHaveBeenCalledExactlyOnceWith()
    expectNoSecrets(response.text)
    const status = await request("/api/settings")
    expect(status.json().githubApp.configured).toBe(true)
    expectNoSecrets(status.text)
    expect(store.dispatchSettings()).toBeUndefined()
    expect(store.githubConnection()).toBeUndefined()
  })

  it("normalizes surrounding client-secret whitespace without changing the secret", async () => {
    const response = await request("/api/github/app", "POST", {
      appId: 123,
      clientSecret: ` \t${clientSecret}\r\n `,
    })
    expect(response.status).toBe(200)
    expect(store.githubAppSettings()?.clientSecret).toBe(clientSecret)
    expectNoSecrets(response.text)
    expectNoSecrets((await request("/api/settings")).text)
  })

  it.each(["   ", "invalid\tsecret", "invalid\nsecret", "invalid\0secret"])(
    "rejects empty or embedded-control client secrets and preserves saved credentials",
    async (value) => {
      configureApp()
      const response = await request("/api/github/app", "POST", { appId: 123, clientSecret: value })
      expect(response.status).toBe(400)
      expect(response.json()).toMatchObject({ error: "invalid_input", fields: ["clientSecret"] })
      expect(store.githubAppSettings()?.clientSecret).toBe(clientSecret)
      expect(transport.app).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
    },
  )

  it("rejects incomplete service setup with actionable field names", async () => {
    const missing = await request("/api/github/app", "POST", { appId: 123 })
    expect(missing.status).toBe(400)
    expect(missing.json()).toMatchObject({ error: "invalid_input", fields: ["clientSecret"] })
    const invalid = await request("/api/github/app", "POST", { appId: 0, clientSecret })
    expect(invalid.status).toBe(400)
    expect(invalid.json()).toMatchObject({ error: "invalid_input", fields: ["appId"] })
    expectNoSecrets(invalid.text)
    expect(store.githubAppSettings()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })

  it("authorizes an existing installation and saves a repository without manual IDs or runtime dispatch", async () => {
    configureApp()
    const { url, state } = await start()
    expect(url.origin).toBe("https://github.com")
    expect(url.pathname).toBe("/login/oauth/authorize")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/auth/github/callback`)
    expect(url.searchParams.get("client_id")).toBe(app.clientId)
    expect(state).toBeTruthy()
    const callback = await authorize(state)
    expect(callback.status).toBe(303)
    expect(callback.headers.location).toBe("/?github_connect=ready#github")
    const choices = await request("/api/github/connect")
    expect(choices.json()).toMatchObject({
      state: "select_repository",
      repositories: [{ id: 456, fullName: "example/project", installationId: 789 }],
    })
    expectNoSecrets(choices.text)
    expect(store.githubConnection()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
    const selected = await request("/api/github/connect/select", "POST", { repositoryId: 456 })
    expect(selected.status).toBe(200)
    expect(store.githubConnection()).toMatchObject({
      appId: 123,
      repository: { owner: "example", name: "project", id: 456, installationId: 789 },
      user: { id: 99, login: "github-admin" },
    })
    expect(changed).toHaveBeenCalledExactlyOnceWith()
    expect(store.dispatchSettings()).toBeUndefined()
    expect((await request("/api/github/connect")).json().state).toBe("idle")
    expectNoSecrets((await request("/api/settings")).text)
    expectNoSecrets(JSON.stringify(log.error.mock.calls))
  })

  it.each([
    ".github",
    "..repo",
    ".repo.name",
    "...",
    "-repo",
    "_repo",
    "repo.-_name",
    "a",
    "a".repeat(100),
  ])(
    "authorizes, refreshes, selects, and saves Runtime for %s with a managed user through the API",
    async (name) => {
      configureApp()
      const user = { id: 99, login: "mona-cat_octo" }
      const selected = { ...repository, name, fullName: `${repository.owner}/${name}` }
      vi.mocked(transport.user).mockResolvedValue(user)
      vi.mocked(transport.repositories).mockResolvedValue([selected])
      const { state } = await start()
      expect((await authorize(state)).headers.location).toBe("/?github_connect=ready#github")
      const choices = await request("/api/github/connect")
      expect(choices.json()).toMatchObject({
        state: "select_repository",
        repositories: [{ id: repository.id, name, fullName: selected.fullName }],
        user,
      })
      const refreshed = await request("/api/github/connect/refresh", "POST")
      expect(refreshed.status).toBe(200)
      expect(refreshed.json().repositories[0].name).toBe(name)
      expect(
        (await request("/api/github/connect/select", "POST", { repositoryId: repository.id }))
          .status,
      ).toBe(200)
      const identity = {
        id: repository.id,
        owner: repository.owner,
        name,
        installationId: installation.id,
      }
      expect(store.githubConnection()).toMatchObject({ repository: identity, user })
      const saved = await request("/api/runtime/settings", "POST", {
        appId: app.id,
        repository: identity,
        image: `sha256:${"b".repeat(64)}`,
        forbiddenPaths: ["security/**"],
      })
      expect(saved.status).toBe(200)
      expect(store.dispatchSettings()?.repository).toEqual(identity)
      const settings = await request("/api/settings")
      expect(settings.json()).toMatchObject({
        githubConnection: { repository: identity, user },
        runtimeSettings: { repository: identity },
      })
      for (const response of [choices, refreshed, saved, settings]) expectNoSecrets(response.text)
    },
  )

  it.each(["owner", "name", "fullName"])(
    "fails closed on malformed discovered repository %s without saving or reloading",
    async (field) => {
      configureApp()
      const invalid = { owner: "mona-cat_octo", name: "..", fullName: "other/project" }
      vi.mocked(transport.repositories).mockResolvedValue([
        { ...repository, [field]: invalid[field as keyof typeof invalid] },
      ])
      const { state } = await start()
      const callback = await authorize(state)
      expect(callback.headers.location).toBe("/?github_connect=github_connect_failed#github")
      expect((await request("/api/github/connect")).json().state).toBe("idle")
      expect(store.githubConnection()).toBeUndefined()
      expect(store.dispatchSettings()).toBeUndefined()
      expect(changed).not.toHaveBeenCalled()
      expectNoSecrets(callback.text)
    },
  )

  it("refreshes repository access after external approval and removes revoked choices", async () => {
    configureApp()
    vi.mocked(transport.installations).mockResolvedValueOnce([])
    const { state } = await start()
    await authorize(state)
    expect((await request("/api/github/connect")).json().state).toBe("install_required")
    const refreshed = await request("/api/github/connect/refresh", "POST")
    expect(refreshed.status).toBe(200)
    expect(refreshed.json()).toMatchObject({
      state: "select_repository",
      repositories: [{ id: 456, installationId: 789 }],
    })
    expectNoSecrets(refreshed.text)
    vi.mocked(transport.repositories).mockResolvedValue([{ ...repository, permissions: {} }])
    const revoked = await request("/api/github/connect/refresh", "POST")
    expect(revoked.status).toBe(200)
    expect(revoked.json()).toMatchObject({ state: "install_required", repositories: [] })
    expect(
      (await request("/api/github/connect/select", "POST", { repositoryId: 456 })).status,
    ).toBe(403)
    expect(store.githubConnection()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })

  it("cannot refresh before OAuth or commit a refresh after cancellation", async () => {
    configureApp()
    const { state } = await start()
    expect((await request("/api/github/connect/refresh", "POST")).status).toBe(409)
    await authorize(state)
    let complete = (_value: { id: number; login: string }) => {}
    vi.mocked(transport.user).mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const refreshing = request("/api/github/connect/refresh", "POST")
    await vi.waitFor(() => expect(transport.user).toHaveBeenCalledTimes(2))
    expect(
      (await request("/api/github/connect/select", "POST", { repositoryId: 456 })).status,
    ).toBe(409)
    await request("/api/github/connect/cancel", "POST")
    complete({ id: 99, login: "github-admin" })
    expect((await refreshing).status).toBeGreaterThanOrEqual(400)
    expect((await request("/api/github/connect")).json().state).toBe("idle")
    expect(store.githubConnection()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })

  it("rejects cross-session and replayed callbacks without exposing code or state", async () => {
    configureApp()
    const { state } = await start()
    const firstToken = token
    const second = store.createSession("another-admin", "Another Admin", ["reina-admins"])
    token = second.token
    const crossed = await authorize(state)
    expect(crossed.status).toBe(303)
    expect(crossed.headers.location).not.toBe("/?github_connect=ready#github")
    expect(transport.exchange).not.toHaveBeenCalled()
    token = firstToken
    const valid = await authorize(state)
    expect(valid.headers.location).toBe("/?github_connect=ready#github")
    const replay = await authorize(state)
    expect(replay.headers.location).not.toBe("/?github_connect=ready#github")
    expect(transport.exchange).toHaveBeenCalledTimes(1)
    expect(replay.headers.location).not.toContain(state)
    expect(replay.headers.location).not.toContain("fixture-code")
    expect(store.githubConnection()).toBeUndefined()
  })

  it("installs through a second one-use state and verifies callback installation access", async () => {
    configureApp()
    vi.mocked(transport.installations).mockResolvedValueOnce([])
    const { state } = await start()
    expect((await authorize(state)).headers.location).toBe("/?github_connect=ready#github")
    expect((await request("/api/github/connect")).json().state).toBe("install_required")
    const install = await request("/api/github/connect/install", "POST")
    expect(install.status).toBe(200)
    const url = new URL(install.json().url)
    expect(url.origin).toBe("https://github.com")
    expect(url.pathname).toBe("/apps/reina-fixture/installations/new")
    const installState = url.searchParams.get("state")
    expect(installState).not.toBe(state)
    const callback = await request(
      `/auth/github/setup?installation_id=789&setup_action=install&state=${installState}`,
    )
    expect(callback.headers.location).toBe("/?github_connect=ready#github")
    expect((await request("/api/github/connect")).json()).toMatchObject({
      state: "select_repository",
      repositories: [{ id: 456, installationId: 789 }],
    })
    expect(transport.installation).toHaveBeenCalled()
    expect(store.githubConnection()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })

  it("rejects unoffered repositories, malformed callbacks, and arbitrary redirect targets", async () => {
    configureApp()
    const { state } = await start()
    await authorize(state)
    const selected = await request("/api/github/connect/select", "POST", { repositoryId: 999 })
    expect(selected.status).toBeGreaterThanOrEqual(400)
    expectNoSecrets(selected.text)
    expect(store.githubConnection()).toBeUndefined()
    const invalid = await request("/api/github/connect/select", "POST", { repositoryId: 0 })
    expect(invalid.status).toBe(400)
    expect(invalid.json()).toMatchObject({ error: "invalid_input", fields: ["repositoryId"] })
    const callback = await request(
      "/auth/github/callback?code=private-code&state=bad&next=https://attacker.invalid",
    )
    expect(callback.status).toBe(303)
    expect(callback.headers.location).toMatch(/^\/\?github_connect=github_connect_/)
    expect(callback.headers.location).not.toContain("attacker.invalid")
    expect(callback.headers.location).not.toContain("private-code")
    expect((await request("/auth/github/callback", "POST")).status).toBe(404)
    expect(
      (await request("/auth/github/setup", "GET", undefined, { anonymous: true })).headers.location,
    ).toBe("/login")
    expect(changed).not.toHaveBeenCalled()
  })

  it("cancels pending authorization on logout and rejects late callback completion", async () => {
    configureApp()
    const { state } = await start()
    let complete = (_value: string) => {}
    vi.mocked(transport.exchange).mockImplementationOnce(
      async () =>
        new Promise<string>((resolve) => {
          complete = resolve
        }),
    )
    const callback = authorize(state)
    await vi.waitFor(() => expect(transport.exchange).toHaveBeenCalledOnce())
    expect((await request("/auth/logout", "POST")).status).toBe(200)
    complete(userToken)
    expect((await callback).headers.location).not.toBe("/?github_connect=ready#github")
    expect((await request("/api/github/connect")).status).toBe(401)
    expect(store.githubConnection()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })

  it("cancels a pending flow without changing the verified connection", async () => {
    configureApp()
    const { state } = await start()
    await authorize(state)
    expect((await request("/api/github/connect/cancel", "POST")).status).toBe(200)
    expect((await request("/api/github/connect")).json().state).toBe("idle")
    expect(
      (await request("/api/github/connect/select", "POST", { repositoryId: 456 })).status,
    ).toBeGreaterThanOrEqual(400)
    expect(store.githubConnection()).toBeUndefined()
    expect(changed).not.toHaveBeenCalled()
  })
})
