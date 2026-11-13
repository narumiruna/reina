import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type DispatchInput,
  dispatchInputSchema,
  dispatchSettingsSchema,
} from "../src/settings/dispatch.js"
import {
  type GitHubAppSettings,
  type GitHubConnection,
  gitHubAppSettingsSchema,
  gitHubConnectionSchema,
} from "../src/settings/github.js"
import { isPublicAddress, validateProviderUrl } from "../src/settings/network.js"
import { modelSchema, providerSchema, validatePrivateKey } from "../src/settings/schema.js"
import { SettingsStore } from "../src/settings/store.js"
import { loadWebConfig } from "../src/web/config.js"

const master = "a".repeat(64)
const apiKey = "fixture-provider-secret-never-returned"
const provider = {
  name: "Example",
  api: "openai-completions" as const,
  baseUrl: "https://model.example/v1",
  apiKey,
}
const dispatchInput: DispatchInput = {
  appId: 123,
  webhookSecret: "fixture-webhook-secret-never-returned",
  repository: { owner: "example", name: "project", id: 456, installationId: 789 },
  image: `ghcr.io/example/reina@sha256:${"d".repeat(64)}`,
  forbiddenPaths: ["src/security/**", "src/deployment/**"],
}
const appSettings: GitHubAppSettings = {
  appId: dispatchInput.appId,
  clientId: "Iv23.fixture-client_id",
  slug: "reina-fixture",
  clientSecret: "fixture-app-client-secret-never-returned",
  webhookSecret: "fixture-app-webhook-secret-never-returned",
}
const connection: GitHubConnection = {
  appId: appSettings.appId,
  repository: { ...dispatchInput.repository },
  connectedAt: 1_800_000_000_000,
  user: { id: 42, login: "verified-operator" },
}
const model = {
  modelId: "example/model",
  name: "Example model",
  contextWindow: 128000,
  maxTokens: 4096,
}
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString()
let directory: string
let store: SettingsStore
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "reina-settings-test-"))
  store = new SettingsStore(directory, master)
})
afterEach(() => {
  vi.useRealTimers()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

describe("encrypted settings", () => {
  it("starts empty and persists configured metadata and the selected runtime snapshot", () => {
    expect(store.providers()).toEqual([])
    expect(store.selection()).toBeUndefined()
    expect(store.githubStatus()).toEqual({ configured: false })
    const id = store.saveProvider(provider)
    const mid = store.saveModel(id, model)
    store.selectModel(mid)
    const snapshot = store.selection()
    expect(snapshot).toMatchObject({
      model: model.modelId,
      modelKey: apiKey,
      modelApi: provider.api,
      modelProvider: id,
      maxTokens: 4096,
    })
    store.close()
    store = new SettingsStore(directory, master)
    expect(store.selectedModelId()).toBe(mid)
    expect(store.selection()).toEqual(snapshot)
    expect(JSON.stringify(store.providers())).not.toContain(apiKey)
    expect(store.providers()[0].hasApiKey).toBe(true)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(path.join(directory, "settings.sqlite")).mode & 0o777).toBe(0o600)
  })

  it("encrypts credentials and PEM in SQLite and never returns their contents in metadata", () => {
    store.saveProvider(provider)
    store.savePrivateKey(pem)
    expect(store.privateKey()).toBe(pem.trim())
    expect(store.githubStatus()).toMatchObject({
      configured: true,
      fingerprint: expect.stringMatching(/^SHA256:/),
      uploadedAt: expect.any(Number),
    })
    expect(JSON.stringify(store.githubStatus())).not.toContain("PRIVATE KEY")
    const database = new DatabaseSync(path.join(directory, "settings.sqlite"))
    const rows = database
      .prepare("SELECT encrypted_key AS value FROM providers UNION ALL SELECT value FROM secrets")
      .all()
    expect(JSON.stringify(rows)).not.toContain(apiKey)
    expect(JSON.stringify(rows)).not.toContain("BEGIN PRIVATE KEY")
    for (const row of rows)
      expect(JSON.parse(String(row.value))).toMatchObject({
        v: 1,
        nonce: expect.any(String),
        tag: expect.any(String),
        data: expect.any(String),
      })
    database.close()
  })

  it("fails closed with a wrong master key without overwriting saved credentials", () => {
    store.saveProvider(provider)
    store.savePrivateKey(pem)
    expect(() => new SettingsStore(directory, "b".repeat(64))).toThrow(
      "settings_storage_or_encryption_unavailable",
    )
    expect(store.privateKey()).toBe(pem.trim())
    expect(store.providers()).toHaveLength(1)
  })

  it("binds ciphertext to its provider purpose and detects tampering", () => {
    const first = store.saveProvider(provider)
    const second = store.saveProvider({ ...provider, name: "Second" })
    const mid = store.saveModel(second, model)
    store.selectModel(mid)
    const database = new DatabaseSync(path.join(directory, "settings.sqlite"))
    database
      .prepare(
        "UPDATE providers SET encrypted_key=(SELECT encrypted_key FROM providers WHERE id=?) WHERE id=?",
      )
      .run(first, second)
    database.close()
    expect(() => store.selection()).toThrow("settings_decryption_failed")
  })

  it("preserves a saved key on unrelated edits but requires a new key when changing endpoint", () => {
    const id = store.saveProvider(provider)
    const mid = store.saveModel(id, model)
    store.selectModel(mid)
    const { apiKey: ignored, ...metadata } = provider
    store.saveProvider({ ...metadata, name: "Renamed" }, id)
    expect(store.selection()?.modelKey).toBe(apiKey)
    expect(() =>
      store.saveProvider({ ...metadata, baseUrl: "https://other.example/v1" }, id),
    ).toThrow("api_key_required_for_new_endpoint")
    expect(store.selection()?.modelUrl).toBe(provider.baseUrl)
    store.saveProvider(
      { ...provider, baseUrl: "https://other.example/v1", apiKey: "replacement-key" },
      id,
    )
    expect(store.selection()?.modelKey).toBe("replacement-key")
  })

  it("requires configured credentials before model selection and clears selection on deletion", () => {
    const id = store.saveProvider({
      name: provider.name,
      api: provider.api,
      baseUrl: provider.baseUrl,
    })
    const mid = store.saveModel(id, model)
    expect(() => store.selectModel(mid)).toThrow("provider_api_key_required")
    store.saveProvider(provider, id)
    store.selectModel(mid)
    store.deleteProvider(id)
    expect(store.selectedModelId()).toBeNull()
    expect(store.selection()).toBeUndefined()
    expect(store.model(mid)).toBeUndefined()
  })

  it("changes snapshot identity for model metadata and credential replacement", () => {
    const id = store.saveProvider(provider)
    const mid = store.saveModel(id, model)
    store.selectModel(mid)
    const original = store.selection()?.modelRevision
    store.saveProvider({ ...provider, apiKey: "rotated" }, id)
    const rotated = store.selection()?.modelRevision
    expect(rotated).not.toBe(original)
    store.saveModel(id, { ...model, maxTokens: 2048 }, mid)
    expect(store.selection()?.modelRevision).not.toBe(rotated)
    expect(store.selection()?.maxTokens).toBe(2048)
    store.deleteModel(mid)
    expect(store.selectedModelId()).toBeNull()
  })

  it("rejects duplicate model IDs, invalid parents and invalid selection", () => {
    const id = store.saveProvider(provider)
    store.saveModel(id, model)
    expect(() => store.saveModel(id, model)).toThrow("model_already_exists")
    expect(() => store.saveModel("missing", model)).toThrow("provider_not_found")
    expect(() => store.selectModel("missing")).toThrow("model_not_found")
  })

  it("allows PEM replacement/removal without storing filenames", () => {
    store.savePrivateKey(pem)
    const before = store.githubStatus().fingerprint
    const replacement = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs1", format: "pem" })
      .toString()
    store.savePrivateKey(replacement)
    expect(store.githubStatus().fingerprint).not.toBe(before)
    store.deletePrivateKey()
    expect(store.privateKey()).toBeUndefined()
    expect(store.githubStatus()).toEqual({ configured: false })
  })
})

describe("encrypted GitHub App settings and verified connections", () => {
  it("starts empty and encrypts complete records without a schema migration or public credentials", () => {
    expect(store.githubAppSettings()).toBeUndefined()
    expect(store.githubAppStatus()).toBeUndefined()
    expect(store.githubConnection()).toBeUndefined()
    store.saveGitHubAppSettings(appSettings)
    store.saveGitHubConnection(connection)
    expect(store.githubAppSettings()).toEqual(appSettings)
    expect(store.githubConnection()).toEqual(connection)
    const { clientSecret, webhookSecret, ...metadata } = appSettings
    expect(store.githubAppStatus()).toEqual({
      ...metadata,
      clientSecretConfigured: true,
      webhookSecretConfigured: true,
    })
    for (const field of ["clientSecret", "webhookSecret"])
      expect(store.githubAppStatus()).not.toHaveProperty(field)
    const database = new DatabaseSync(path.join(directory, "settings.sqlite"))
    try {
      const rows = database
        .prepare("SELECT * FROM secrets WHERE name IN ('github-app-settings','github-connection')")
        .all()
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.metadata).toBe("{}")
        expect(JSON.parse(String(row.value))).toMatchObject({ v: 1, data: expect.any(String) })
      }
      const output = JSON.stringify(rows)
      for (const value of [
        clientSecret,
        webhookSecret,
        appSettings.clientId,
        appSettings.slug,
        connection.repository.owner,
        connection.user.login,
        "appId",
        "connectedAt",
      ])
        expect(output).not.toContain(value)
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(3)
    } finally {
      database.close()
    }
    store.close()
    store = new SettingsStore(directory, master)
    expect(store.githubAppSettings()).toEqual(appSettings)
    expect(store.githubConnection()).toEqual(connection)
    const publicMetadata = JSON.stringify([
      store.githubAppStatus(),
      store.githubStatus(),
      store.dispatchStatus(),
      store.providers(),
    ])
    expect(publicMetadata).not.toContain(clientSecret)
    expect(publicMetadata).not.toContain(webhookSecret)
  })

  it("tracks credential writes and key deletion with a stable internal revision", () => {
    const empty = store.githubRevision()
    expect(empty).toMatch(/^[a-f0-9]{64}$/)
    expect(store.githubRevision()).toBe(empty)
    store.saveGitHubAppSettings(appSettings)
    const appSaved = store.githubRevision()
    expect(appSaved).not.toBe(empty)
    expect(store.githubRevision()).toBe(appSaved)
    store.saveGitHubConnection(connection)
    store.saveDispatchSettings(dispatchInput)
    expect(store.githubRevision()).toBe(appSaved)
    store.saveGitHubAppSettings(appSettings)
    const appRewritten = store.githubRevision()
    expect(appRewritten).not.toBe(appSaved)
    store.saveGitHubAppSettings({ ...appSettings, clientSecret: "rotated-client-secret" })
    const appRotated = store.githubRevision()
    store.saveGitHubAppSettings(appSettings)
    const appRestored = store.githubRevision()
    expect(new Set([empty, appSaved, appRewritten, appRotated, appRestored]).size).toBe(5)
    store.savePrivateKey(pem)
    const keySaved = store.githubRevision()
    store.savePrivateKey(pem)
    const keyRewritten = store.githubRevision()
    store.close()
    store = new SettingsStore(directory, master)
    expect(store.githubRevision()).toBe(keyRewritten)
    store.deletePrivateKey()
    const keyDeleted = store.githubRevision()
    expect(keyDeleted).toBe(appRestored)
    store.savePrivateKey(pem)
    const keyRestored = store.githubRevision()
    expect(new Set([appRestored, keySaved, keyRewritten, keyRestored]).size).toBe(4)
  })

  it("returns independent validated copies without retaining caller mutations", () => {
    const inputApp = { ...appSettings }
    const inputConnection = structuredClone(connection)
    store.saveGitHubAppSettings(inputApp)
    store.saveGitHubConnection(inputConnection)
    inputApp.clientSecret = "mutated"
    inputConnection.repository.id = 1
    inputConnection.user.login = "mutated"
    const trusted = store.githubAppSettings()
    const visible = store.githubAppStatus()
    const verified = store.githubConnection()
    if (!trusted || !visible || !verified) throw new Error("github_fixture_missing")
    trusted.webhookSecret = "mutated"
    visible.clientId = "mutated"
    verified.repository.installationId = 1
    verified.user.id = 1
    expect(store.githubAppSettings()).toEqual(appSettings)
    expect(store.githubConnection()).toEqual(connection)
    expect(store.githubAppStatus()?.clientId).toBe(appSettings.clientId)
  })

  it("accepts real GitHub client identifiers and bounded metadata", () => {
    for (const clientId of ["Iv23liExample1234567890", "a", "a".repeat(100), "id._-123"]) {
      expect(gitHubAppSettingsSchema.parse({ ...appSettings, clientId }).clientId).toBe(clientId)
    }
    expect(
      gitHubAppSettingsSchema.parse({
        ...appSettings,
        appId: Number.MAX_SAFE_INTEGER,
        slug: "a".repeat(100),
        clientSecret: "s".repeat(4_096),
        webhookSecret: "s".repeat(4_096),
      }),
    ).toMatchObject({ appId: Number.MAX_SAFE_INTEGER })
    for (const connectedAt of [0, Number.MAX_SAFE_INTEGER])
      expect(gitHubConnectionSchema.parse({ ...connection, connectedAt }).connectedAt).toBe(
        connectedAt,
      )
  })

  it.each([
    ["appId", 0],
    ["appId", 1.5],
    ["appId", Number.MAX_SAFE_INTEGER + 1],
    ["appId", "123"],
    ["clientId", ""],
    ["clientId", "a".repeat(101)],
    ["clientId", "Iv23/client"],
    ["clientId", "Iv23client\n"],
    ["clientId", "non-ascii-識別子"],
    ["slug", ""],
    ["slug", "Uppercase"],
    ["slug", "-invalid"],
    ["slug", "invalid-"],
    ["slug", "invalid_slug"],
    ["slug", "a".repeat(101)],
    ["slug", "slug\n"],
    ["clientSecret", ""],
    ["clientSecret", " secret"],
    ["clientSecret", "secret "],
    ["clientSecret", "secret\n"],
    ["clientSecret", "secret\0value"],
    ["clientSecret", "secret\u007fvalue"],
    ["clientSecret", "s".repeat(4_097)],
    ["webhookSecret", "short"],
    ["webhookSecret", "s".repeat(4_097)],
    ["webhookSecret", ` ${appSettings.webhookSecret}`],
    ["webhookSecret", `${appSettings.webhookSecret}\n`],
    ["token", "private-invalid-input"],
  ])("rejects invalid App %s with a safe error and no saved changes", (field, value) => {
    store.saveGitHubAppSettings(appSettings)
    store.saveGitHubConnection(connection)
    expect(() => store.saveGitHubAppSettings({ ...appSettings, [field]: value })).toThrow(
      /^invalid_github_app_settings$/,
    )
    expect(store.githubAppSettings()).toEqual(appSettings)
    expect(store.githubConnection()).toEqual(connection)
  })

  it.each([
    ["appId", 0],
    ["appId", Number.MAX_SAFE_INTEGER + 1],
    ["repository", { ...connection.repository, id: 0 }],
    ["repository", { ...connection.repository, installationId: 1.5 }],
    ["repository", { ...connection.repository, owner: "-invalid" }],
    ["repository", { ...connection.repository, name: "../invalid" }],
    ["repository", { ...connection.repository, token: "private-invalid-input" }],
    ["connectedAt", -1],
    ["connectedAt", 1.5],
    ["connectedAt", Number.MAX_SAFE_INTEGER + 1],
    ["connectedAt", "1800000000000"],
    ["user", { id: 0, login: "operator" }],
    ["user", { id: Number.MAX_SAFE_INTEGER + 1, login: "operator" }],
    ["user", { id: 42, login: "" }],
    ["user", { id: 42, login: "operator\n" }],
    ["user", { id: 42, login: "../operator" }],
    ["user", { id: 42, login: "a".repeat(40) }],
    ["user", { id: 42, login: "operator", token: "private-invalid-input" }],
    ["token", "private-invalid-input"],
  ])(
    "rejects invalid connection %s without storing tokens or changing the record",
    (field, value) => {
      store.saveGitHubAppSettings(appSettings)
      store.saveGitHubConnection(connection)
      expect(() => store.saveGitHubConnection({ ...connection, [field]: value })).toThrow(
        /^invalid_github_connection$/,
      )
      expect(store.githubConnection()).toEqual(connection)
    },
  )

  it("permits a verified legacy connection but rejects an App identity mismatch when settings exist", () => {
    store.saveGitHubConnection(connection)
    expect(store.githubConnection()).toEqual(connection)
    store.saveGitHubAppSettings(appSettings)
    expect(store.githubConnection()).toEqual(connection)
    expect(() => store.saveGitHubConnection({ ...connection, appId: 999 })).toThrow(
      /^github_app_mismatch$/,
    )
    expect(store.githubConnection()).toEqual(connection)
  })

  it("preserves a connection on same-App rotation and deletes only that record when App identity changes", () => {
    const providerId = store.saveProvider(provider)
    const modelId = store.saveModel(providerId, model)
    store.selectModel(modelId)
    store.savePrivateKey(pem)
    store.saveDispatchSettings(dispatchInput)
    store.saveGitHubAppSettings(appSettings)
    store.saveGitHubConnection(connection)
    const selected = store.selection()
    const session = store.createSession("subject", "Operator", ["reina-admins"])
    const database = new DatabaseSync(path.join(directory, "settings.sqlite"))
    try {
      const unrelated = database
        .prepare(
          "SELECT * FROM secrets WHERE name NOT IN ('github-app-settings','github-connection') ORDER BY name",
        )
        .all()
      const rotated = {
        ...appSettings,
        clientSecret: "replacement-client-secret",
        webhookSecret: "replacement-app-webhook-secret-32",
      }
      store.saveGitHubAppSettings(rotated)
      expect(store.githubConnection()).toEqual(connection)
      store.saveGitHubAppSettings({ ...rotated, appId: 999 })
      expect(store.githubConnection()).toBeUndefined()
      expect(store.githubAppSettings()?.appId).toBe(999)
      expect(store.dispatchSettings()?.appId).toBe(dispatchInput.appId)
      expect(store.dispatchSettings()?.webhookSecret).toBe(dispatchInput.webhookSecret)
      expect(
        database
          .prepare(
            "SELECT * FROM secrets WHERE name NOT IN ('github-app-settings','github-connection') ORDER BY name",
          )
          .all(),
      ).toEqual(unrelated)
      expect(store.selection()).toEqual(selected)
      expect(store.privateKey()).toBe(pem.trim())
      expect(store.session(session.token)).toBeDefined()
      expect(() => store.saveGitHubConnection(connection)).toThrow(/^github_app_mismatch$/)
      store.saveGitHubConnection({ ...connection, appId: 999 })
      expect(store.githubConnection()?.appId).toBe(999)
    } finally {
      database.close()
    }
  })

  it.each([
    ["github-app-settings", "invalid_github_app_settings"],
    ["github-connection", "invalid_github_connection"],
  ] as const)(
    "fails closed on malformed or tampered %s records and enforces purpose binding",
    (purpose, error) => {
      store.saveGitHubAppSettings(appSettings)
      store.saveGitHubConnection(connection)
      const read = () =>
        purpose === "github-app-settings" ? store.githubAppSettings() : store.githubConnection()
      const database = new DatabaseSync(path.join(directory, "settings.sqlite"))
      try {
        for (const plaintext of [
          "not-json",
          "{}",
          '{"appId":0}',
          JSON.stringify({ ...connection, token: apiKey }),
        ]) {
          const nonce = randomBytes(12)
          const cipher = createCipheriv("aes-256-gcm", Buffer.from(master, "hex"), nonce)
          cipher.setAAD(Buffer.from(`reina:v1:${purpose}`))
          const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
          database.prepare("UPDATE secrets SET value=? WHERE name=?").run(
            JSON.stringify({
              v: 1,
              nonce: nonce.toString("base64"),
              tag: cipher.getAuthTag().toString("base64"),
              data: data.toString("base64"),
            }),
            purpose,
          )
          expect(read).toThrow(new RegExp(`^${error}$`))
          if (purpose === "github-app-settings")
            expect(() => store.githubAppStatus()).toThrow(/^invalid_github_app_settings$/)
        }
        for (const wrongPurpose of [
          "encryption-check",
          purpose === "github-app-settings" ? "github-connection" : "github-app-settings",
        ]) {
          database
            .prepare(
              "UPDATE secrets SET value=(SELECT value FROM secrets WHERE name=?) WHERE name=?",
            )
            .run(wrongPurpose, purpose)
          expect(read).toThrow(new RegExp(`^${error}$`))
        }
        if (purpose === "github-app-settings") {
          expect(() => store.saveGitHubAppSettings(appSettings)).toThrow(
            /^invalid_github_app_settings$/,
          )
          expect(() => store.saveGitHubConnection(connection)).toThrow(
            /^invalid_github_app_settings$/,
          )
          expect(() =>
            store.saveDispatchSettings({ ...dispatchInput, webhookSecret: undefined }),
          ).toThrow(/^invalid_github_app_settings$/)
        }
      } finally {
        database.close()
      }
    },
  )
})

describe("persisted dispatch settings", () => {
  it("starts unconfigured and persists a complete encrypted object without a schema change", () => {
    expect(store.dispatchSettings()).toBeUndefined()
    expect(store.dispatchStatus()).toBeUndefined()
    store.saveDispatchSettings(dispatchInput)
    const complete = dispatchSettingsSchema.parse(dispatchInputSchema.parse(dispatchInput))
    expect(store.dispatchSettings()).toEqual(complete)
    const { webhookSecret, ...visible } = complete
    expect(store.dispatchStatus()).toEqual({ ...visible, webhookSecretConfigured: true })
    expect(store.dispatchStatus()).not.toHaveProperty("webhookSecret")
    expect(JSON.stringify(store.dispatchStatus())).not.toContain(webhookSecret)
    const database = new DatabaseSync(path.join(directory, "settings.sqlite"))
    try {
      const row = database.prepare("SELECT * FROM secrets WHERE name='dispatch-settings'").get()
      expect(row?.metadata).toBe("{}")
      expect(JSON.parse(String(row?.value))).toMatchObject({ v: 1, data: expect.any(String) })
      for (const value of [webhookSecret, complete.repository.owner, complete.image, "appId"])
        expect(JSON.stringify(row)).not.toContain(value)
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(3)
    } finally {
      database.close()
    }
    store.close()
    store = new SettingsStore(directory, master)
    expect(store.dispatchSettings()).toEqual(complete)
    expect(store.dispatchStatus()).toEqual({ ...visible, webhookSecretConfigured: true })
  })

  it("requires a secret on first save and retains it across edits and restart", () => {
    const { webhookSecret, ...withoutSecret } = dispatchInput
    expect(() => store.saveDispatchSettings(withoutSecret)).toThrow(/^webhook_secret_required$/)
    expect(store.dispatchSettings()).toBeUndefined()
    store.saveDispatchSettings(dispatchInput)
    store.close()
    store = new SettingsStore(directory, master)
    store.saveDispatchSettings({ ...withoutSecret, scanIntervalMs: 120_000 })
    expect(store.dispatchSettings()?.webhookSecret).toBe(webhookSecret)
    expect(store.dispatchStatus()?.scanIntervalMs).toBe(120_000)
    for (const value of ["", "short", ` ${webhookSecret}`, `${webhookSecret}\n`]) {
      expect(() => store.saveDispatchSettings({ ...withoutSecret, webhookSecret: value })).toThrow(
        /^invalid_dispatch_settings$/,
      )
      expect(store.dispatchSettings()?.webhookSecret).toBe(webhookSecret)
    }
    const replacement = "replacement-webhook-secret-value-32"
    store.saveDispatchSettings({ ...withoutSecret, webhookSecret: replacement })
    expect(store.dispatchSettings()?.webhookSecret).toBe(replacement)
    expect(JSON.stringify(store.dispatchStatus())).not.toContain(replacement)
  })

  it("uses the current matching App webhook secret when dispatch input omits it", () => {
    store.saveGitHubAppSettings(appSettings)
    const { webhookSecret: omitted, ...input } = dispatchInput
    store.saveDispatchSettings(input)
    expect(store.dispatchSettings()?.webhookSecret).toBe(appSettings.webhookSecret)
    const replacement = "rotated-app-webhook-secret-value-32"
    store.saveGitHubAppSettings({ ...appSettings, webhookSecret: replacement })
    store.saveDispatchSettings(input)
    expect(store.dispatchSettings()?.webhookSecret).toBe(replacement)
    store.saveDispatchSettings(dispatchInput)
    expect(store.dispatchSettings()?.webhookSecret).toBe(omitted)
    store.saveDispatchSettings(input)
    expect(store.dispatchSettings()?.webhookSecret).toBe(replacement)
  })

  it("does not reuse a previous dispatch secret after its App identity changes", () => {
    store.saveDispatchSettings(dispatchInput)
    const original = store.dispatchSettings()
    const { webhookSecret: omitted, ...input } = dispatchInput
    expect(() => store.saveDispatchSettings({ ...input, appId: 999 })).toThrow(
      /^webhook_secret_required$/,
    )
    expect(store.dispatchSettings()).toEqual(original)
    store.saveDispatchSettings({
      ...input,
      appId: 999,
      webhookSecret: "explicit-new-app-webhook-secret-32",
    })
    expect(store.dispatchSettings()?.appId).toBe(999)
  })

  it("never imports an unrelated App secret and keeps same-App dispatch fallback", () => {
    store.saveGitHubAppSettings({ ...appSettings, appId: 999 })
    const { webhookSecret: omitted, ...input } = dispatchInput
    expect(() => store.saveDispatchSettings(input)).toThrow(/^webhook_secret_required$/)
    store.saveDispatchSettings(dispatchInput)
    store.saveDispatchSettings({ ...input, scanIntervalMs: 120_000 })
    expect(store.dispatchSettings()?.webhookSecret).toBe(omitted)
    expect(store.dispatchSettings()?.webhookSecret).not.toBe(appSettings.webhookSecret)
  })

  it("replaces a prior App secret only with the new App's own secret", () => {
    store.saveGitHubAppSettings(appSettings)
    const { webhookSecret: omitted, ...input } = dispatchInput
    store.saveDispatchSettings(input)
    const next = {
      ...appSettings,
      appId: 999,
      webhookSecret: "new-app-webhook-secret-value-at-least-32",
    }
    store.saveGitHubAppSettings(next)
    store.saveDispatchSettings({ ...input, appId: next.appId })
    expect(store.dispatchSettings()?.webhookSecret).toBe(next.webhookSecret)
    expect(store.dispatchSettings()?.webhookSecret).not.toBe(appSettings.webhookSecret)
  })

  it("returns independent copies of trusted and public nested settings", () => {
    store.saveDispatchSettings(dispatchInput)
    const original = store.dispatchSettings()
    const trusted = store.dispatchSettings()
    const status = store.dispatchStatus()
    if (!trusted || !status) throw new Error("settings_fixture_missing")
    trusted.repository.id = 1
    trusted.commands[0].push("mutated")
    status.repository.installationId = 1
    status.allowedPaths.length = 0
    expect(store.dispatchSettings()).toEqual(original)
    expect(store.dispatchStatus()?.allowedPaths).toEqual(original?.allowedPaths)
  })

  it.each([
    ["appId", 0],
    ["appId", 1.5],
    ["appId", Number.MAX_SAFE_INTEGER + 1],
    ["appId", "123"],
    ["repository", { ...dispatchInput.repository, owner: "-invalid" }],
    ["repository", { ...dispatchInput.repository, name: "../project" }],
    ["repository", { ...dispatchInput.repository, id: 0 }],
    ["repository", { ...dispatchInput.repository, installationId: -1 }],
    ["repository", { ...dispatchInput.repository, token: "private-invalid-input" }],
    ["image", "worker:latest"],
    ["allowedPaths", []],
    ["allowedPaths", ["../outside/**"]],
    ["allowedPaths", ["src/**", "SRC/**"]],
    ["forbiddenPaths", []],
    ["forbiddenPaths", ["!src/security/**"]],
    ["commands", []],
    ["commands", ["npm run ci"]],
    ["commands", [["npm", "run\nci"]]],
    ["commands", [Array(33).fill("npm")]],
    ["commands", Array(9).fill(["npm"])],
    ["commands", [["x".repeat(4_097)]]],
    ["commands", Array(8).fill(Array(32).fill("x".repeat(256)))],
    ["scanIntervalMs", 59_999],
    ["scanIntervalMs", 86_400_001],
    ["maxIssuesPerScan", 11],
    ["maxConcurrentJobs", 2],
    ["agentTimeoutMs", 999],
    ["agentTimeoutMs", 600_001],
    ["maxChangedFiles", 11],
    ["maxPatchBytes", 65_537],
    ["stateDir", "/private-invalid-input"],
    ["private-invalid-input", "private-invalid-input"],
  ])("rejects invalid %s without changing saved settings or disclosing input", (field, value) => {
    store.saveDispatchSettings(dispatchInput)
    const original = store.dispatchSettings()
    expect(() => store.saveDispatchSettings({ ...dispatchInput, [field]: value })).toThrow(
      /^invalid_dispatch_settings$/,
    )
    expect(store.dispatchSettings()).toEqual(original)
  })

  it("fails closed on encrypted malformed settings and ciphertext tampering", () => {
    store.saveDispatchSettings(dispatchInput)
    const database = new DatabaseSync(path.join(directory, "settings.sqlite"))
    try {
      for (const plaintext of ["not-json", JSON.stringify(dispatchInput), '{"appId":0}']) {
        const nonce = randomBytes(12)
        const cipher = createCipheriv("aes-256-gcm", Buffer.from(master, "hex"), nonce)
        cipher.setAAD(Buffer.from("reina:v1:dispatch-settings"))
        const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
        database.prepare("UPDATE secrets SET value=? WHERE name='dispatch-settings'").run(
          JSON.stringify({
            v: 1,
            nonce: nonce.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            data: data.toString("base64"),
          }),
        )
        expect(() => store.dispatchSettings()).toThrow(/^invalid_dispatch_settings$/)
        expect(() => store.dispatchStatus()).toThrow(/^invalid_dispatch_settings$/)
      }
      database
        .prepare(
          "UPDATE secrets SET value=(SELECT value FROM secrets WHERE name='encryption-check') WHERE name='dispatch-settings'",
        )
        .run()
      expect(() => store.dispatchSettings()).toThrow(/^invalid_dispatch_settings$/)
      expect(() =>
        store.saveDispatchSettings({ ...dispatchInput, webhookSecret: undefined }),
      ).toThrow(/^invalid_dispatch_settings$/)
      // An explicit complete replacement can recover the settings without legacy fallback.
      store.saveDispatchSettings(dispatchInput)
      expect(store.dispatchSettings()?.appId).toBe(dispatchInput.appId)
    } finally {
      database.close()
    }
  })
})

describe("private key validation", () => {
  it("accepts RSA PKCS8/PKCS1 with CRLF and computes public-key fingerprint", () => {
    expect(validatePrivateKey(pem.replaceAll("\n", "\r\n")).pem).toBe(pem.trim())
    expect(validatePrivateKey(pem).fingerprint).toMatch(/^SHA256:/)
  })
  it.each([
    "not-a-key",
    "-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----",
    "x".repeat(32769),
  ])("rejects malformed/oversized PEM without disclosing it", (value) => {
    expect(() => validatePrivateKey(value)).toThrow(/^invalid_private_key$/)
  })
  it("rejects public, weak RSA, encrypted and non-RSA keys", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
    for (const value of [
      rsa.publicKey.export({ type: "spki", format: "pem" }),
      rsa.privateKey.export({ type: "pkcs8", format: "pem" }),
      ec.privateKey.export({ type: "pkcs8", format: "pem" }),
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "fixture-passphrase",
      }),
    ]) {
      expect(() => validatePrivateKey(value.toString())).toThrow(/^invalid_private_key$/)
    }
  })
})

describe("private sessions", () => {
  it("stores only session token hashes and revokes logout sessions", () => {
    const session = store.createSession("subject", "Admin", ["reina-admins"])
    expect(store.session(session.token)).toEqual({
      subject: "subject",
      name: "Admin",
      csrfToken: session.csrfToken,
      groups: ["reina-admins"],
    })
    const database = new DatabaseSync(path.join(directory, "settings.sqlite"))
    const row = database.prepare("SELECT hash FROM sessions").get()
    expect(row?.hash).toBe(createHash("sha256").update(session.token).digest("hex"))
    expect(row?.hash).not.toBe(session.token)
    database.close()
    store.deleteSession(session.token)
    expect(store.session(session.token)).toBeUndefined()
    expect(store.session("invalid")).toBeUndefined()
  })
  it("invalidates sessions when the issuer, client, or public origin changes", () => {
    const context = JSON.stringify(["https://reina.narumi.dev", "https://id.example", "client"])
    store.bindAuthContext(context)
    const session = store.createSession("subject", "Admin", ["reina-admins"])
    store.bindAuthContext(context)
    expect(store.session(session.token)).toBeDefined()
    store.bindAuthContext(
      JSON.stringify(["https://reina.narumi.dev", "https://another-id.example", "client"]),
    )
    expect(store.session(session.token)).toBeUndefined()
  })
  it("persists a validated login-time group snapshot and does not mutate it through callers", () => {
    const membership = ["user", "reina-admins", "reina-admins"]
    const session = store.createSession("subject", "Admin", membership)
    membership.length = 0
    expect(store.session(session.token)?.groups).toEqual(["user", "reina-admins"])
    const loaded = store.session(session.token)
    loaded?.groups.push("another-group")
    expect(store.session(session.token)?.groups).toEqual(["user", "reina-admins"])
    store.close()
    store = new SettingsStore(directory, master)
    expect(store.session(session.token)?.groups).toEqual(["user", "reina-admins"])
  })
  it("fails closed on malformed stored membership and rejects invalid new sessions", () => {
    const session = store.createSession("subject", "Admin", ["reina-admins"])
    const database = new DatabaseSync(path.join(directory, "settings.sqlite"))
    try {
      for (const value of [
        "not-json",
        '"reina-admins"',
        '{"reina-admins":true}',
        '["reina-admins",null]',
      ]) {
        database.prepare("UPDATE sessions SET groups=?").run(value)
        expect(store.session(session.token)).toBeUndefined()
      }
    } finally {
      database.close()
    }
    expect(() => store.createSession("subject", "Admin", ["reina-admins\n"])).toThrow()
  })
  it("invalidates sessions when the configured group policy changes", () => {
    const identity = ["oidc-groups-v1", "https://reina.narumi.dev", "https://id.example", "client"]
    store.bindAuthContext(JSON.stringify([...identity, ["reina-admins"]]))
    const session = store.createSession("subject", "Admin", ["reina-admins"])
    store.bindAuthContext(JSON.stringify([...identity, ["operators"]]))
    expect(store.session(session.token)).toBeUndefined()
  })
  it("migrates v1 sessions without changing encrypted provider keys, PEM, models, or selection", () => {
    const legacyDirectory = path.join(directory, "legacy")
    const legacy = new SettingsStore(legacyDirectory, master)
    const providerId = legacy.saveProvider(provider)
    const modelId = legacy.saveModel(providerId, model)
    legacy.selectModel(modelId)
    legacy.savePrivateKey(pem)
    const original = legacy.selection()
    const fingerprint = legacy.githubStatus().fingerprint
    legacy.close()
    const file = path.join(legacyDirectory, "settings.sqlite")
    const database = new DatabaseSync(file)
    try {
      database.exec(`DROP TABLE sessions;
        CREATE TABLE sessions(hash TEXT PRIMARY KEY,subject TEXT NOT NULL,name TEXT NOT NULL,
          csrf TEXT NOT NULL,expires_at INTEGER NOT NULL) STRICT;
        ALTER TABLE providers DROP COLUMN sdk_provider;
        ALTER TABLE providers DROP COLUMN credential_type;
        ALTER TABLE providers DROP COLUMN credential_generation;
        PRAGMA user_version=1;`)
      const nonce = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", Buffer.from(master, "hex"), nonce)
      cipher.setAAD(Buffer.from(`reina:v1:provider:${providerId}`))
      const data = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()])
      database.prepare("UPDATE providers SET encrypted_key=? WHERE id=?").run(
        JSON.stringify({
          v: 1,
          nonce: nonce.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          data: data.toString("base64"),
        }),
        providerId,
      )
      database
        .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
        .run(
          createHash("sha256").update("b".repeat(64)).digest("hex"),
          "legacy-subject",
          "Legacy Admin",
          "legacy-csrf",
          Date.now() + 60_000,
        )
    } finally {
      database.close()
    }
    // A wrong key must roll back the schema change and session deletion too.
    expect(() => new SettingsStore(legacyDirectory, "c".repeat(64))).toThrow(
      "settings_storage_or_encryption_unavailable",
    )
    const unchanged = new DatabaseSync(file)
    try {
      expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(1)
      expect(unchanged.prepare("SELECT count(*) AS count FROM sessions").get()?.count).toBe(1)
      expect(
        unchanged
          .prepare("PRAGMA table_info(sessions)")
          .all()
          .map((row) => row.name),
      ).not.toContain("groups")
    } finally {
      unchanged.close()
    }
    const upgraded = new SettingsStore(legacyDirectory, master)
    try {
      expect(upgraded.session("b".repeat(64))).toBeUndefined()
      expect(upgraded.selection()).toMatchObject({ ...original, modelRevision: expect.any(String) })
      expect(upgraded.selection()?.modelRevision).not.toBe(original?.modelRevision)
      expect(upgraded.privateKey()).toBe(pem.trim())
      expect(upgraded.githubStatus().fingerprint).toBe(fingerprint)
      expect(upgraded.selectedModelId()).toBe(modelId)
      const inspection = new DatabaseSync(file)
      try {
        expect(inspection.prepare("PRAGMA user_version").get()?.user_version).toBe(3)
        expect(inspection.prepare("SELECT count(*) AS count FROM sessions").get()?.count).toBe(0)
      } finally {
        inspection.close()
      }
      const fresh = upgraded.createSession("legacy-subject", "Admin", ["reina-admins"])
      expect(upgraded.session(fresh.token)?.groups).toEqual(["reina-admins"])
    } finally {
      upgraded.close()
    }
  })

  it("expires sessions after eight hours", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-13T00:00:00Z"))
    const session = store.createSession("subject", "Admin", ["reina-admins"])
    vi.advanceTimersByTime(8 * 60 * 60 * 1000)
    expect(store.session(session.token)).toBeUndefined()
  })
})

describe("settings validation", () => {
  it.each([
    "http://example.com/v1",
    "https://user:pass@example.com/v1",
    "https://example.com/v1?token=secret",
    "https://example.com/#fragment",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://169.254.169.254/",
    "https://localhost/v1",
  ])("rejects unsafe provider endpoint %s", (value) => {
    expect(() => validateProviderUrl(value)).toThrow()
  })
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "224.0.0.1",
  ])("rejects nonpublic IP %s", (value) => {
    expect(isPublicAddress(value)).toBe(false)
  })
  it("accepts public destinations and enforces bounded text-only model metadata", () => {
    expect(isPublicAddress("1.1.1.1")).toBe(true)
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true)
    expect(providerSchema.parse(provider)).toEqual(provider)
    expect(() => providerSchema.parse({ ...provider, apiKey: "secret\n" })).toThrow()
    for (const value of [
      { ...model, modelId: "invalid:thinking" },
      { ...model, maxTokens: 4097 },
      { ...model, contextWindow: 100 },
      { ...model, input: ["image"] },
    ])
      expect(() => modelSchema.parse(value)).toThrow()
  })
  it("loads only bootstrap settings; an empty OIDC configuration stays locked", () => {
    const config = loadWebConfig({ REINA_STATE_DIR: directory, ENCRYPTION_KEY: master })
    expect(config.port).toBe(36816)
    expect(config.auth.origin).toBe("https://reina.narumi.dev")
    expect(config.auth.allowedGroups).toEqual([])
    expect(config.auth.issuer).toBe("")
  })
  it("normalizes configured group names and ignores the removed subject setting", () => {
    const base = { REINA_STATE_DIR: directory, ENCRYPTION_KEY: master }
    expect(
      loadWebConfig({ ...base, OIDC_ALLOWED_GROUPS: "reina-admins, operators,reina-admins" }).auth
        .allowedGroups,
    ).toEqual(["operators", "reina-admins"])
    const old = loadWebConfig({ ...base, OIDC_ALLOWED_SUBJECTS: "reina-admins" })
    expect(old.auth.allowedGroups).toEqual([])
    expect(old.auth).not.toHaveProperty("allowedSubjects")
    expect(loadWebConfig({ ...base, OIDC_ALLOWED_GROUPS: "" }).auth.allowedGroups).toEqual([])
  })
  it.each(["reina-admins\u200b", "reina-admins\n", "x".repeat(257)])(
    "rejects invalid configured group names without echoing input",
    (value) => {
      expect(() =>
        loadWebConfig({
          REINA_STATE_DIR: directory,
          ENCRYPTION_KEY: master,
          OIDC_ALLOWED_GROUPS: value,
        }),
      ).toThrow(/^Invalid web configuration fields: OIDC_ALLOWED_GROUPS$/)
    },
  )
  it("rejects invalid bootstrap fields without printing their values", () => {
    const secret = "private-input-that-must-not-leak"
    expect(() => loadWebConfig({ REINA_STATE_DIR: directory, ENCRYPTION_KEY: secret })).toThrow(
      /^Invalid web configuration fields: ENCRYPTION_KEY$/,
    )
    expect(() =>
      loadWebConfig({
        REINA_STATE_DIR: directory,
        ENCRYPTION_KEY: master,
        PUBLIC_URL: "http://public.example",
      }),
    ).toThrow(/PUBLIC_URL/)
    chmodSync(directory, 0o755)
    expect(() => loadWebConfig({ REINA_STATE_DIR: directory, ENCRYPTION_KEY: master })).toThrow(
      /REINA_STATE_DIR/,
    )
  })
  it("does not embed secrets in the frontend assets", () => {
    for (const file of ["index.html", "login.html", "app.js", "style.css"]) {
      const value = readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8")
      expect(value).not.toContain(apiKey)
      expect(value).not.toContain("BEGIN PRIVATE KEY")
      expect(value).not.toMatch(/localStorage|sessionStorage/)
    }
  })
})
