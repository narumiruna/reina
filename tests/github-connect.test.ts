import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import {
  FixedGitHubConnectTransport,
  type GitHubConnectRepository,
  type GitHubConnectTransport,
} from "../src/github/connect.js"
import { SettingsStore } from "../src/settings/store.js"
import { GitHubConnect, GitHubConnectError } from "../src/web/github-connect.js"

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})
const pem = privateKey.trim()
const origin = "https://reina.example"
const owner = "fixture-session-csrf"
const otherOwner = "another-session-csrf"
const token = "fixture-transient-user-token"
const clientSecret = "fixture-client-secret"
const webhookSecret = "fixture-webhook-secret-never-returned"
const app = {
  appId: 123,
  clientId: "Iv1.fixture",
  slug: "fixture-app",
  clientSecret,
  webhookSecret,
}
const user = { id: 789, login: "operator" }
const repositoryNames = [
  ".github",
  "..repo",
  ".repo.name",
  "...",
  "-repo",
  "_repo",
  "repo.-_name",
  "a",
  "a".repeat(100),
]
const invalidRepositoryNames = [
  "",
  ".",
  "..",
  "repo/name",
  "repo\\name",
  "repo name",
  " repo",
  "repo ",
  "repo\tname",
  "repo\n",
  "repo\0name",
  "repo\u007fname",
  "repo\u200bname",
  "repo\u00a0name",
  "répo",
  "a".repeat(101),
]
const installation = { id: 321, appId: app.appId, suspended: false }
const repository: GitHubConnectRepository = {
  id: 456,
  owner: "example",
  name: "project",
  fullName: "example/project",
  archived: false,
  disabled: false,
  permissions: { push: true },
}
const choice = {
  id: 456,
  owner: "example",
  name: "project",
  fullName: "example/project",
  installationId: 321,
}
let directory: string
let store: SettingsStore
let active: Set<string>
let service: GitHubConnect
let transport: ReturnType<typeof fakeTransport>
const services: GitHubConnect[] = []

function fakeTransport() {
  return {
    app: vi.fn<GitHubConnectTransport["app"]>(async () => ({
      id: app.appId,
      clientId: app.clientId,
      slug: app.slug,
    })),
    exchange: vi.fn<GitHubConnectTransport["exchange"]>(async () => token),
    user: vi.fn<GitHubConnectTransport["user"]>(async () => ({ ...user })),
    installations: vi.fn<GitHubConnectTransport["installations"]>(async () => [
      { ...installation },
    ]),
    repositories: vi.fn<GitHubConnectTransport["repositories"]>(async () => [
      structuredClone(repository),
    ]),
    installation: vi.fn<GitHubConnectTransport["installation"]>(async () => ({ ...installation })),
  }
}
function connect(env: NodeJS.ProcessEnv = {}) {
  const instance = new GitHubConnect(
    store,
    { ownerActive: (value) => active.has(value) },
    origin,
    env,
    transport,
  )
  services.push(instance)
  return instance
}
function configure() {
  store.savePrivateKey(pem)
  store.saveGitHubAppSettings(app)
}
function callback(startUrl: string, phase = "oauth") {
  const url = new URL(phase === "oauth" ? "/auth/github/callback" : "/auth/github/setup", origin)
  url.searchParams.set("state", new URL(startUrl).searchParams.get("state") as string)
  if (phase === "oauth") url.searchParams.set("code", "fixture-authorization-code")
  else {
    url.searchParams.set("installation_id", String(installation.id))
    url.searchParams.set("setup_action", "install")
  }
  return url
}
async function authorize(who = owner) {
  const start = await service.start(who)
  await service.oauthCallback(who, callback(start.url))
  return start
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function mockAbortTimers() {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), milliseconds)
    return controller.signal
  })
}
function previousConnection() {
  const previous = {
    appId: app.appId,
    repository: { id: 12, owner: "old-owner", name: "old-repo", installationId: 34 },
    connectedAt: 1,
    user,
  }
  store.saveGitHubConnection(previous)
  return previous
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"))
  directory = mkdtempSync(join(tmpdir(), "reina-github-connect-"))
  store = new SettingsStore(directory, "a".repeat(64))
  active = new Set([owner, otherOwner])
  transport = fakeTransport()
  service = connect()
})
afterEach(() => {
  for (const instance of services.splice(0)) instance.close()
  store.close()
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("existing GitHub App configuration", () => {
  it("returns only safe local status and exact distinct callback URLs", () => {
    expect(service.status()).toEqual({
      configured: false,
      clientSecretConfigured: false,
      webhookSecretConfigured: false,
      privateKeyConfigured: false,
      callbackUrl: `${origin}/auth/github/callback`,
      setupUrl: `${origin}/auth/github/setup`,
    })
    configure()
    expect(service.status()).toEqual({
      configured: true,
      appId: app.appId,
      clientSecretConfigured: true,
      webhookSecretConfigured: true,
      privateKeyConfigured: true,
      callbackUrl: `${origin}/auth/github/callback`,
      setupUrl: `${origin}/auth/github/setup`,
    })
    expect(transport.app).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(service.status())).not.toContain(clientSecret)
    expect(JSON.stringify(service.status())).not.toContain(webhookSecret)
    expect(JSON.stringify(service.status())).not.toContain("PRIVATE KEY")
  })

  it("uses only explicit legacy environment settings before service settings exist", async () => {
    service = connect({ APP_ID: "999", WEBHOOK_SECRET: webhookSecret })
    expect(service.status()).toMatchObject({
      configured: false,
      appId: 999,
      webhookSecretConfigured: true,
      clientSecretConfigured: false,
    })
    await expect(service.start(owner)).rejects.toMatchObject({
      code: "github_connect_not_configured",
    })
    configure()
    expect(service.status()).toMatchObject({ configured: true, appId: 123 })
  })

  it("inherits only matching legacy webhook secrets and derives metadata with App authentication", async () => {
    store.savePrivateKey(pem)
    service = connect({ APP_ID: String(app.appId), WEBHOOK_SECRET: webhookSecret })
    await service.saveApp(owner, { appId: app.appId, clientSecret })
    expect(store.githubAppSettings()).toEqual(app)
    expect(transport.app).toHaveBeenCalledWith(
      { appId: app.appId, privateKey: pem },
      expect.any(AbortSignal),
    )
    expect(store.dispatchSettings()).toBeUndefined()
  })

  it("inherits matching complete dispatch settings without returning or changing policy", async () => {
    store.savePrivateKey(pem)
    store.saveDispatchSettings({
      appId: app.appId,
      webhookSecret,
      repository: {
        id: choice.id,
        owner: choice.owner,
        name: choice.name,
        installationId: choice.installationId,
      },
      image: `sha256:${"b".repeat(64)}`,
      forbiddenPaths: ["security/**"],
    })
    const before = store.dispatchSettings()
    expect(service.status()).toMatchObject({
      appId: app.appId,
      webhookSecretConfigured: true,
      configured: false,
    })
    await service.saveApp(owner, { appId: app.appId, clientSecret })
    expect(store.githubAppSettings()).toEqual(app)
    expect(store.dispatchSettings()).toEqual(before)
  })

  it("preserves omitted same-App secrets, but never inherits secrets for a changed App", async () => {
    configure()
    await service.saveApp(owner, { appId: app.appId })
    expect(store.githubAppSettings()).toEqual(app)
    await expect(service.saveApp(owner, { appId: 999 })).rejects.toBeInstanceOf(z.ZodError)
    expect(store.githubAppSettings()).toEqual(app)
  })

  it.each([
    { appId: 0, clientSecret, webhookSecret },
    { appId: "123", clientSecret, webhookSecret },
    { appId: 123, clientSecret: "", webhookSecret },
    { appId: 123, clientSecret, webhookSecret: "short" },
    { appId: 123, clientSecret, webhookSecret, slug: "browser-chosen" },
    { appId: 123, clientSecret, webhookSecret, clientId: "browser-chosen" },
  ])("rejects malformed or browser-derived App settings %#", async (input) => {
    await expect(service.saveApp(owner, input)).rejects.toBeInstanceOf(z.ZodError)
    expect(transport.app).not.toHaveBeenCalled()
  })

  it("reports missing secrets as field errors and makes no metadata request", async () => {
    store.savePrivateKey(pem)
    await expect(service.saveApp(owner, { appId: 123 })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["clientSecret"] }),
        expect.objectContaining({ path: ["webhookSecret"] }),
      ]),
    })
    expect(transport.app).not.toHaveBeenCalled()
  })

  it("rejects mismatched authenticated App metadata and preserves previous settings", async () => {
    configure()
    transport.app.mockResolvedValueOnce({ id: 999, clientId: "other", slug: "other" })
    await expect(
      service.saveApp(owner, { appId: 123, clientSecret: "new-secret" }),
    ).rejects.toMatchObject({ code: "github_connect_access_denied" })
    expect(store.githubAppSettings()).toEqual(app)
  })

  it.each(["key", "credentials", "logout", "cancel", "close"])(
    "does not save App metadata after %s while verification is pending",
    async (change) => {
      configure()
      const pending = deferred<{ id: number; clientId: string; slug: string }>()
      transport.app.mockReturnValueOnce(pending.promise)
      const work = service.saveApp(owner, { appId: 123, clientSecret: "new-secret" })
      if (change === "key") store.savePrivateKey(pem)
      if (change === "credentials") store.saveGitHubAppSettings(app)
      if (change === "logout") active.delete(owner)
      if (change === "cancel") service.cancelOwner(owner)
      if (change === "close") service.close()
      pending.resolve({ id: 123, clientId: app.clientId, slug: app.slug })
      await expect(work).rejects.toBeInstanceOf(GitHubConnectError)
      expect(store.githubAppSettings()).toEqual(app)
      expect(transport.app.mock.calls[0][1].aborted).toBe(true)
    },
  )
})

describe("session-bound OAuth and repository selection", () => {
  beforeEach(configure)

  it("starts OAuth before installation, with cryptographic state and PKCE and no extra scopes", async () => {
    const start = await service.start(owner)
    const url = new URL(start.url)
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
    expect([...url.searchParams.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "state",
    ])
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/auth/github/callback`)
    expect(service.view(owner)).toMatchObject({ state: "connecting", repositories: [] })
    await service.oauthCallback(owner, callback(start.url))
    const exchange = transport.exchange.mock.calls[0][0]
    expect(exchange.clientSecret).toBe(clientSecret)
    expect(exchange.callbackUrl).toBe(`${origin}/auth/github/callback`)
    expect(createHash("sha256").update(exchange.verifier).digest("base64url")).toBe(
      url.searchParams.get("code_challenge"),
    )
    expect(transport.installations).toHaveBeenCalledWith(token, expect.any(AbortSignal))
    expect(transport.repositories).toHaveBeenCalledWith(
      token,
      installation.id,
      expect.any(AbortSignal),
    )
    expect(service.view(owner)).toMatchObject({
      state: "select_repository",
      repositories: [choice],
      user,
    })
    expect(store.githubConnection()).toBeUndefined()
  })

  it("reuses an existing installation, rechecks App ownership and user access, then saves only verified connection", async () => {
    await authorize()
    await service.select(owner, repository.id)
    expect(transport.installation).toHaveBeenCalledWith(
      { appId: app.appId, privateKey: pem },
      installation.id,
      expect.any(AbortSignal),
    )
    expect(transport.user).toHaveBeenCalledTimes(2)
    expect(transport.installations).toHaveBeenCalledTimes(2)
    expect(transport.repositories).toHaveBeenCalledTimes(2)
    expect(store.githubConnection()).toEqual({
      appId: app.appId,
      repository: {
        id: repository.id,
        owner: repository.owner,
        name: repository.name,
        installationId: installation.id,
      },
      connectedAt: expect.any(Number),
      user,
    })
    expect(store.dispatchSettings()).toBeUndefined()
    expect(service.view(owner)).toEqual({ state: "idle", repositories: [] })
    await expect(service.select(owner, repository.id)).rejects.toMatchObject({
      code: "github_connect_expired",
    })
  })

  it.each(
    repositoryNames.flatMap((name) =>
      ["operator", "mona-cat_octo", `${"a".repeat(35)}_org`].map((login) => ({ name, login })),
    ),
  )(
    "connects, refreshes, selects, and reopens Runtime through real transport for $name / $login",
    async ({ name, login }) => {
      const selectedRepository = { ...repository, name, fullName: `${repository.owner}/${name}` }
      const selectedUser = { ...user, login }
      const unrelated = { ...repository, id: repository.id + 1 }
      const fetch = vi.mocked(globalThis.fetch)
      fetch.mockImplementation(async (target) => {
        switch (String(target)) {
          case "https://github.com/login/oauth/access_token":
            return json({ access_token: token, token_type: "bearer" })
          case "https://api.github.com/user":
            return json(selectedUser)
          case "https://api.github.com/user/installations?per_page=100&page=1":
            return json({
              installations: [{ id: installation.id, app_id: app.appId, suspended_at: null }],
            })
          case "https://api.github.com/user/installations/321/repositories?per_page=100&page=1":
            return json({
              repositories: [selectedRepository, unrelated].map((value) => ({
                ...value,
                full_name: value.fullName,
                owner: { login: value.owner },
              })),
            })
          case "https://api.github.com/app/installations/321":
            return json({ id: installation.id, app_id: app.appId, suspended_at: null })
          default:
            throw new Error("unexpected fixture request")
        }
      })
      service = new GitHubConnect(
        store,
        { ownerActive: (value) => active.has(value) },
        origin,
        {},
        new FixedGitHubConnectTransport(),
      )
      services.push(service)
      await authorize()
      const expectedChoice = { ...choice, name, fullName: selectedRepository.fullName }
      expect(service.view(owner)).toMatchObject({
        state: "select_repository",
        repositories: [expectedChoice, { ...choice, id: unrelated.id }],
        user: selectedUser,
      })
      expect((await service.refresh(owner)).repositories[0]).toEqual(expectedChoice)
      await service.select(owner, selectedRepository.id)
      const verified = store.githubConnection()
      if (!verified) throw new Error("github_fixture_missing")
      expect(verified.repository).toEqual({
        id: repository.id,
        owner: repository.owner,
        name,
        installationId: installation.id,
      })
      expect(verified.user).toEqual(selectedUser)
      store.saveDispatchSettings({
        appId: app.appId,
        repository: verified.repository,
        image: `sha256:${"b".repeat(64)}`,
        forbiddenPaths: ["security/**"],
      })
      const runtime = store.dispatchSettings()
      store.close()
      store = new SettingsStore(directory, "a".repeat(64))
      expect(store.githubConnection()).toEqual(verified)
      expect(store.dispatchSettings()).toEqual(runtime)
      expect(store.dispatchStatus()?.repository).toEqual(verified.repository)
      expect(fetch.mock.calls.filter(([target]) => String(target).endsWith("/user"))).toHaveLength(
        3,
      )
    },
  )

  it.each([
    ["owner", "mona-cat_octo"],
    ["name", "."],
    ["name", ".."],
    ["name", "bad/name"],
    ["name", "a".repeat(101)],
    ["fullName", "other/project"],
    ["id", Number.MAX_SAFE_INTEGER + 1],
  ])(
    "rejects malformed flow repository %s without changing the saved connection",
    async (field, value) => {
      const previous = previousConnection()
      transport.repositories.mockResolvedValue([{ ...repository, [field]: value }])
      const start = await service.start(owner)
      await expect(service.oauthCallback(owner, callback(start.url))).rejects.toMatchObject({
        code: "github_connect_failed",
      })
      expect(service.view(owner).state).toBe("idle")
      expect(store.githubConnection()).toEqual(previous)
    },
  )

  it.each(["refresh", "select"])(
    "rejects a changed managed login on %s with the same user ID",
    async (operation) => {
      const previous = previousConnection()
      transport.user.mockResolvedValue({ ...user, login: "mona-cat_octo" })
      await authorize()
      transport.user.mockResolvedValue({ ...user, login: "mona-cat_other" })
      const pending =
        operation === "refresh" ? service.refresh(owner) : service.select(owner, repository.id)
      await expect(pending).rejects.toMatchObject({ code: "github_connect_access_denied" })
      expect(store.githubConnection()).toEqual(previous)
      expect(service.view(owner).state).toBe("idle")
    },
  )

  it("rejects a changed leading-dot repository tuple at selection", async () => {
    const previous = previousConnection()
    transport.repositories.mockResolvedValue([
      { ...repository, name: ".github", fullName: "example/.github" },
    ])
    await authorize()
    transport.repositories.mockResolvedValue([
      { ...repository, name: ".other", fullName: "example/.other" },
    ])
    await expect(service.select(owner, repository.id)).rejects.toMatchObject({
      code: "github_connect_access_denied",
    })
    expect(store.githubConnection()).toEqual(previous)
  })

  it("requires both user-token repository membership and a writable permission; excludes archived/disabled repos", async () => {
    transport.installations.mockResolvedValue([
      installation,
      { id: 999, appId: 999, suspended: false },
      { id: 888, appId: 123, suspended: true },
    ])
    transport.repositories.mockResolvedValue([
      repository,
      { ...repository, id: 457, permissions: { admin: true } },
      { ...repository, id: 458, permissions: { maintain: true } },
      { ...repository, id: 459, permissions: { push: false } },
      { ...repository, id: 460, archived: true },
      { ...repository, id: 461, disabled: true },
    ])
    await authorize()
    expect(service.view(owner).repositories.map((value) => value.id)).toEqual([456, 457, 458])
    expect(transport.repositories).toHaveBeenCalledTimes(1)
    await expect(service.select(owner, 900)).rejects.toMatchObject({
      code: "github_connect_access_denied",
    })
    expect(store.githubConnection()).toBeUndefined()
  })

  it("never returns secrets, token, code, verifier, or callback state from public views", async () => {
    const start = await authorize()
    const view = service.view(owner)
    const json = JSON.stringify(view)
    for (const secret of [
      token,
      clientSecret,
      webhookSecret,
      "fixture-authorization-code",
      transport.exchange.mock.calls[0][0].verifier,
      new URL(start.url).searchParams.get("state") as string,
      pem,
    ])
      expect(json).not.toContain(secret)
    view.repositories[0].owner = "modified"
    expect(service.view(owner).repositories[0]).toEqual(choice)
    const requests = transport.repositories.mock.calls.length
    service.view(owner)
    service.status()
    expect(transport.repositories).toHaveBeenCalledTimes(requests)
  })

  it("rejects callback replay before and after the first exchange completes", async () => {
    const start = await service.start(owner)
    const url = callback(start.url)
    const pending = deferred<string>()
    transport.exchange.mockReturnValueOnce(pending.promise)
    const first = service.oauthCallback(owner, url)
    await expect(service.oauthCallback(owner, url)).rejects.toMatchObject({
      code: "github_connect_expired",
    })
    pending.resolve(token)
    await first
    await expect(service.oauthCallback(owner, url)).rejects.toMatchObject({
      code: "github_connect_expired",
    })
    expect(transport.exchange).toHaveBeenCalledTimes(1)
  })

  it("rejects cross-owner states without consuming the correct owner's state", async () => {
    const first = await service.start(owner)
    const second = await service.start(otherOwner)
    await expect(service.oauthCallback(otherOwner, callback(first.url))).rejects.toMatchObject({
      code: "github_connect_expired",
    })
    await service.oauthCallback(owner, callback(first.url))
    await service.oauthCallback(otherOwner, callback(second.url))
    expect(service.view(owner).state).toBe("select_repository")
    expect(service.view(otherOwner).state).toBe("select_repository")
  })

  it.each([
    "wrong_origin",
    "wrong_path",
    "duplicate_state",
    "duplicate_code",
    "missing_code",
    "denied",
  ])("rejects %s callback input safely", async (kind) => {
    const start = await service.start(owner)
    const url = callback(start.url)
    if (kind === "wrong_origin") url.hostname = "evil.example"
    if (kind === "wrong_path") url.pathname = "/auth/github/setup"
    if (kind === "duplicate_state") url.searchParams.append("state", "another")
    if (kind === "duplicate_code") url.searchParams.append("code", "another")
    if (kind === "missing_code") url.searchParams.delete("code")
    if (kind === "denied") url.searchParams.set("error", "access_denied")
    await expect(service.oauthCallback(owner, url)).rejects.toBeInstanceOf(GitHubConnectError)
    expect(transport.exchange).not.toHaveBeenCalled()
  })

  it("replaces only the initiating owner's earlier flow", async () => {
    const old = await service.start(owner)
    const other = await service.start(otherOwner)
    const next = await service.start(owner)
    expect(next.url).not.toBe(old.url)
    await expect(service.oauthCallback(owner, callback(old.url))).rejects.toMatchObject({
      code: "github_connect_expired",
    })
    await service.oauthCallback(owner, callback(next.url))
    await service.oauthCallback(otherOwner, callback(other.url))
  })

  it.each([
    "membership",
    "repository_membership",
    "permission",
    "archived",
    "disabled",
    "tuple",
    "app",
    "suspended",
    "user",
  ])("preserves the previous connection if %s changes before selection", async (change) => {
    const previous = previousConnection()
    await authorize()
    if (change === "membership") transport.installations.mockResolvedValue([])
    if (change === "repository_membership") transport.repositories.mockResolvedValue([])
    if (change === "permission")
      transport.repositories.mockResolvedValue([{ ...repository, permissions: {} }])
    if (change === "archived")
      transport.repositories.mockResolvedValue([{ ...repository, archived: true }])
    if (change === "disabled")
      transport.repositories.mockResolvedValue([{ ...repository, disabled: true }])
    if (change === "tuple")
      transport.repositories.mockResolvedValue([
        { ...repository, owner: "new-owner", fullName: "new-owner/project" },
      ])
    if (change === "app") transport.installation.mockResolvedValue({ ...installation, appId: 999 })
    if (change === "suspended")
      transport.installation.mockResolvedValue({ ...installation, suspended: true })
    if (change === "user") transport.user.mockResolvedValue({ id: 987, login: "another-user" })
    await expect(service.select(owner, repository.id)).rejects.toMatchObject({
      code: "github_connect_access_denied",
    })
    expect(store.githubConnection()).toEqual(previous)
    expect(service.view(owner).state).toBe("idle")
  })

  it("allows only one in-flight selection", async () => {
    await authorize()
    const pending = deferred<typeof user>()
    transport.user.mockReturnValueOnce(pending.promise)
    const first = service.select(owner, repository.id)
    await expect(service.select(owner, repository.id)).rejects.toMatchObject({
      code: "github_connect_stale",
    })
    pending.resolve(user)
    await first
    expect(store.githubConnection()?.repository.id).toBe(repository.id)
  })

  it.each(["key", "credentials", "logout", "cancel", "close", "expiry", "timeout"])(
    "rejects stale selection completion after %s and preserves the previous connection",
    async (change) => {
      vi.useFakeTimers()
      if (change === "timeout") mockAbortTimers()
      const previous = previousConnection()
      await authorize()
      const pending = deferred<GitHubConnectRepository[]>()
      transport.repositories.mockReturnValueOnce(pending.promise)
      const selection = service.select(owner, repository.id)
      for (let count = 0; count < 20; count++) await Promise.resolve()
      if (change === "key") store.savePrivateKey(pem)
      if (change === "credentials") store.saveGitHubAppSettings(app)
      if (change === "logout") active.delete(owner)
      if (change === "cancel") service.cancelOwner(owner)
      if (change === "close") service.close()
      if (change === "expiry") vi.advanceTimersByTime(15 * 60 * 1000)
      if (change === "timeout") vi.advanceTimersByTime(31_000)
      pending.resolve([repository])
      await expect(selection).rejects.toBeInstanceOf(GitHubConnectError)
      expect(store.githubConnection()).toEqual(previous)
    },
  )

  it.each(["key", "credentials", "logout", "cancel", "close", "expiry"])(
    "does not resurrect an OAuth flow after %s when token exchange finishes late",
    async (change) => {
      vi.useFakeTimers()
      const start = await service.start(owner)
      const pending = deferred<string>()
      transport.exchange.mockReturnValueOnce(pending.promise)
      const work = service.oauthCallback(owner, callback(start.url))
      if (change === "key") store.savePrivateKey(pem)
      if (change === "credentials") store.saveGitHubAppSettings(app)
      if (change === "logout") active.delete(owner)
      if (change === "cancel") service.cancelOwner(owner)
      if (change === "close") service.close()
      if (change === "expiry") vi.advanceTimersByTime(15 * 60 * 1000)
      pending.resolve(token)
      await expect(work).rejects.toBeInstanceOf(GitHubConnectError)
      expect(transport.user).not.toHaveBeenCalled()
      if (change !== "logout" && change !== "close") expect(service.view(owner).state).toBe("idle")
    },
  )

  it("expires within 15 minutes without extending the original deadline", async () => {
    vi.useFakeTimers()
    await authorize()
    const deadline = service.view(owner).expiresAt
    vi.advanceTimersByTime(14 * 60 * 1000)
    await service.install(owner)
    expect(service.view(owner).expiresAt).toBe(deadline)
    vi.advanceTimersByTime(60 * 1000)
    expect(service.view(owner)).toEqual({ state: "idle", repositories: [] })
    await expect(service.install(owner)).rejects.toMatchObject({ code: "github_connect_expired" })
  })

  it("caps process flows at 64 and replaces an owner's flow at capacity", async () => {
    for (let index = 0; index < 64; index++) {
      const who = `session-${index}`
      active.add(who)
      await service.start(who)
    }
    await expect(service.start(owner)).rejects.toMatchObject({ code: "github_connect_limit" })
    await expect(service.start("session-0")).resolves.toHaveProperty("url")
  })

  it("maps raw transport failures to fixed safe errors without changing the previous connection", async () => {
    const previous = previousConnection()
    transport.exchange.mockRejectedValue(
      new Error(`${token} ${clientSecret} ${webhookSecret} response-body`),
    )
    const start = await service.start(owner)
    const error = await service.oauthCallback(owner, callback(start.url)).catch((value) => value)
    expect(error).toBeInstanceOf(GitHubConnectError)
    expect(error.message).toBe("github_connect_failed")
    expect(error.status).toBe(400)
    expect(JSON.stringify(error)).not.toContain(token)
    expect(store.githubConnection()).toEqual(previous)
  })
})

describe("verified installation setup", () => {
  beforeEach(configure)

  it("offers installation only after user authorization, and verifies a new installation with both credentials", async () => {
    await expect(service.install(owner)).rejects.toMatchObject({ code: "github_connect_expired" })
    transport.installations.mockResolvedValueOnce([])
    await authorize()
    expect(service.view(owner)).toMatchObject({ state: "install_required", repositories: [], user })
    const install = await service.install(owner)
    const url = new URL(install.url)
    expect(url.origin + url.pathname).toBe("https://github.com/apps/fixture-app/installations/new")
    expect([...url.searchParams.keys()]).toEqual(["state"])
    await service.setupCallback(owner, callback(install.url, "setup"))
    expect(transport.installation).toHaveBeenCalledTimes(1)
    expect(service.view(owner)).toMatchObject({
      state: "select_repository",
      repositories: [choice],
    })
    await service.select(owner, repository.id)
    expect(store.githubConnection()?.repository.id).toBe(repository.id)
  })

  it("can install/manage to add another repository after discovering existing repositories", async () => {
    await authorize()
    const first = await service.install(owner)
    const next = await service.install(owner)
    await expect(service.setupCallback(owner, callback(first.url, "setup"))).rejects.toMatchObject({
      code: "github_connect_expired",
    })
    const update = callback(next.url, "setup")
    update.searchParams.set("setup_action", "update")
    await service.setupCallback(owner, update)
    expect(service.view(owner).repositories).toEqual([choice])
  })

  it.each([
    "wrong_app",
    "spoofed_id",
    "no_user_access",
    "pending",
    "missing_id",
    "duplicate_id",
    "missing_action",
  ])("rejects %s setup callbacks without saving a connection", async (kind) => {
    const previous = previousConnection()
    await authorize()
    const install = await service.install(owner)
    const url = callback(install.url, "setup")
    if (kind === "wrong_app")
      transport.installation.mockResolvedValue({ ...installation, appId: 999 })
    if (kind === "spoofed_id") url.searchParams.set("installation_id", "999")
    if (kind === "no_user_access") transport.installations.mockResolvedValue([])
    if (kind === "pending") url.searchParams.set("setup_action", "request")
    if (kind === "missing_id") url.searchParams.delete("installation_id")
    if (kind === "duplicate_id") url.searchParams.append("installation_id", "999")
    if (kind === "missing_action") url.searchParams.delete("setup_action")
    await expect(service.setupCallback(owner, url)).rejects.toMatchObject({
      code: "github_connect_access_denied",
    })
    await expect(service.setupCallback(owner, url)).rejects.toMatchObject({
      code: "github_connect_expired",
    })
    expect(store.githubConnection()).toEqual(previous)
  })

  it("rejects cross-owner setup state and setup callback replay", async () => {
    await authorize()
    await authorize(otherOwner)
    const install = await service.install(owner)
    const otherInstall = await service.install(otherOwner)
    const url = callback(install.url, "setup")
    await expect(service.setupCallback(otherOwner, url)).rejects.toMatchObject({
      code: "github_connect_expired",
    })
    await service.setupCallback(owner, url)
    await expect(service.setupCallback(owner, url)).rejects.toMatchObject({
      code: "github_connect_expired",
    })
    await service.setupCallback(otherOwner, callback(otherInstall.url, "setup"))
  })
})

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

describe("fixed-host bounded GitHub transport", () => {
  const credentials = { appId: app.appId, privateKey: pem }
  const signal = () => new AbortController().signal
  const rawInstallation = { id: installation.id, app_id: app.appId, suspended_at: null }

  it("signs App JWTs with the uploaded key and never uses them for user access checks", async () => {
    const fetch = vi.mocked(globalThis.fetch)
    fetch.mockResolvedValueOnce(json({ id: app.appId, client_id: app.clientId, slug: app.slug }))
    const fixed = new FixedGitHubConnectTransport()
    expect(await fixed.app(credentials, signal())).toEqual({
      id: app.appId,
      clientId: app.clientId,
      slug: app.slug,
    })
    const [url, options] = fetch.mock.calls[0]
    expect(url).toBe("https://api.github.com/app")
    expect(options?.redirect).toBe("error")
    const authorization = new Headers(options?.headers).get("authorization") as string
    const jwt = authorization.slice("Bearer ".length)
    const [head, payload, signature] = jwt.split(".")
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    })
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString())
    expect(claims.iss).toBe(String(app.appId))
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600)
    expect(
      verify(
        "RSA-SHA256",
        Buffer.from(`${head}.${payload}`),
        createPublicKey(pem),
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true)
  })

  it("exchanges the code with required client_secret and verifier at the fixed OAuth endpoint", async () => {
    const fetch = vi.mocked(globalThis.fetch)
    fetch.mockResolvedValueOnce(
      json({ access_token: token, token_type: "bearer", refresh_token: "discard-this-refresh" }),
    )
    const fixed = new FixedGitHubConnectTransport()
    expect(
      await fixed.exchange(
        {
          clientId: app.clientId,
          clientSecret,
          verifier: "fixture-verifier",
          code: "fixture-code",
          callbackUrl: `${origin}/auth/github/callback`,
        },
        signal(),
      ),
    ).toBe(token)
    const [url, options] = fetch.mock.calls[0]
    expect(url).toBe("https://github.com/login/oauth/access_token")
    expect(options?.method).toBe("POST")
    expect(options?.redirect).toBe("error")
    expect(new Headers(options?.headers).has("authorization")).toBe(false)
    expect(Object.fromEntries(new URLSearchParams(String(options?.body)))).toEqual({
      client_id: app.clientId,
      client_secret: clientSecret,
      code: "fixture-code",
      code_verifier: "fixture-verifier",
      redirect_uri: `${origin}/auth/github/callback`,
    })
  })

  it("uses the user token for user/installation/repository endpoints and normalizes exact repository identity", async () => {
    const fetch = vi.mocked(globalThis.fetch)
    fetch
      .mockResolvedValueOnce(json(user))
      .mockResolvedValueOnce(json({ installations: [rawInstallation] }))
      .mockResolvedValueOnce(
        json({
          repositories: [
            {
              id: repository.id,
              name: repository.name,
              full_name: repository.fullName,
              owner: { login: repository.owner },
              archived: false,
              disabled: false,
              permissions: { push: true },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(json(rawInstallation))
    const fixed = new FixedGitHubConnectTransport()
    expect(await fixed.user(token, signal())).toEqual(user)
    expect(await fixed.installations(token, signal())).toEqual([installation])
    expect(await fixed.repositories(token, installation.id, signal())).toEqual([repository])
    expect(await fixed.installation(credentials, installation.id, signal())).toEqual(installation)
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/user/installations?per_page=100&page=1",
      "https://api.github.com/user/installations/321/repositories?per_page=100&page=1",
      "https://api.github.com/app/installations/321",
    ])
    for (const [, options] of fetch.mock.calls.slice(0, 3))
      expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${token}`)
  })

  it.each(["mona-cat_octo", "a", "a".repeat(39), `${"a".repeat(35)}_org`])(
    "accepts bounded user login %s from the real user endpoint",
    async (login) => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(json({ ...user, login }))
      expect(await new FixedGitHubConnectTransport().user(token, signal())).toEqual({
        ...user,
        login,
      })
    },
  )

  it.each([
    "",
    "a".repeat(40),
    "_operator",
    "operator_",
    "bad/name",
    "bad\\name",
    "bad name",
    "operator\n",
    "op\0erator",
    "op\u007ferator",
    "op\u200berator",
  ])("rejects malformed user login %j from the real user endpoint", async (login) => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(json({ ...user, login }))
    await expect(new FixedGitHubConnectTransport().user(token, signal())).rejects.toThrow(
      "github_connect_transport_failed",
    )
  })

  it.each(invalidRepositoryNames)(
    "rejects an entire repository page containing malformed name %j even without write access",
    async (name) => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        json({
          repositories: [
            { ...repository, full_name: repository.fullName, owner: { login: repository.owner } },
            {
              ...repository,
              id: 457,
              name,
              full_name: `example/${name}`,
              owner: { login: repository.owner },
              archived: true,
              permissions: {},
            },
          ],
        }),
      )
      await expect(
        new FixedGitHubConnectTransport().repositories(token, installation.id, signal()),
      ).rejects.toThrow("github_connect_transport_failed")
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    },
  )

  it("keeps managed underscores out of repository owners at the transport boundary", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      json({
        repositories: [
          {
            ...repository,
            full_name: `mona-cat_octo/${repository.name}`,
            owner: { login: "mona-cat_octo" },
          },
        ],
      }),
    )
    await expect(
      new FixedGitHubConnectTransport().repositories(token, installation.id, signal()),
    ).rejects.toThrow("github_connect_transport_failed")
  })

  it("discovers a writable repository beside a readonly .github repository without dropping either record", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      json({
        repositories: [
          { ...repository, full_name: repository.fullName, owner: { login: repository.owner } },
          {
            ...repository,
            id: 457,
            name: ".github",
            full_name: "example/.github",
            owner: { login: repository.owner },
            permissions: {},
          },
        ],
      }),
    )
    expect(
      await new FixedGitHubConnectTransport().repositories(token, installation.id, signal()),
    ).toEqual([
      repository,
      { ...repository, id: 457, name: ".github", fullName: "example/.github", permissions: {} },
    ])
  })

  it("paginates using only fixed paths, never untrusted Link headers", async () => {
    const fetch = vi.mocked(globalThis.fetch)
    fetch
      .mockResolvedValueOnce(
        json(
          {
            installations: Array.from({ length: 100 }, (_, index) => ({
              ...rawInstallation,
              id: index + 1,
            })),
          },
          200,
          { link: '<https://evil.example/steal>; rel="next"' },
        ),
      )
      .mockResolvedValueOnce(json({ installations: [] }))
    expect(await new FixedGitHubConnectTransport().installations(token, signal())).toHaveLength(100)
    expect(fetch.mock.calls[1][0]).toBe(
      "https://api.github.com/user/installations?per_page=100&page=2",
    )
  })

  it("caps pagination without silently offering truncated results", async () => {
    const fetch = vi.mocked(globalThis.fetch)
    fetch.mockImplementation(async () =>
      json({ installations: Array.from({ length: 100 }, () => rawInstallation) }),
    )
    await expect(new FixedGitHubConnectTransport().installations(token, signal())).rejects.toThrow(
      "github_connect_transport_failed",
    )
    expect(fetch).toHaveBeenCalledTimes(10)
  })

  it.each([302, 401, 403, 429, 500])(
    "does not retry HTTP %s or expose response bodies",
    async (status) => {
      const fetch = vi.mocked(globalThis.fetch)
      fetch.mockResolvedValueOnce(
        new Response(`${token} secret-body`, {
          status,
          headers: { location: "https://evil.example" },
        }),
      )
      await expect(new FixedGitHubConnectTransport().user(token, signal())).rejects.toThrow(
        "github_connect_transport_failed",
      )
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it.each(["declared", "streamed"])("bounds %s response bytes", async (kind) => {
    const fetch = vi.mocked(globalThis.fetch)
    fetch.mockResolvedValueOnce(
      new Response("x".repeat(kind === "streamed" ? 2 * 1024 * 1024 + 1 : 1), {
        headers: kind === "declared" ? { "content-length": "999999999" } : {},
      }),
    )
    await expect(new FixedGitHubConnectTransport().user(token, signal())).rejects.toThrow(
      "github_connect_transport_failed",
    )
  })

  it.each(["json", "schema", "empty"])(
    "rejects invalid %s responses with a fixed safe error",
    async (kind) => {
      const response =
        kind === "json"
          ? new Response(`${token} invalid-json`)
          : kind === "empty"
            ? new Response(null)
            : json({ id: token, login: clientSecret })
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(response)
      const error = await new FixedGitHubConnectTransport()
        .user(token, signal())
        .catch((value) => value)
      expect(error.message).toBe("github_connect_transport_failed")
      expect(error).not.toBeInstanceOf(z.ZodError)
      expect(String(error)).not.toContain(token)
    },
  )

  it("aborts an in-flight request after ten seconds without retry", async () => {
    vi.useFakeTimers()
    mockAbortTimers()
    const fetch = vi.mocked(globalThis.fetch)
    fetch.mockImplementation(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error(`${token} aborted`)), {
            once: true,
          })
        }),
    )
    const work = new FixedGitHubConnectTransport().user(token, signal())
    const checked = expect(work).rejects.toThrow("github_connect_transport_failed")
    await vi.advanceTimersByTimeAsync(10_000)
    await checked
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, "321/../../evil"])(
    "rejects an unsafe installation ID %s before fetch",
    async (value) => {
      await expect(
        new FixedGitHubConnectTransport().repositories(token, value as number, signal()),
      ).rejects.toBeDefined()
      expect(globalThis.fetch).not.toHaveBeenCalled()
    },
  )
})
