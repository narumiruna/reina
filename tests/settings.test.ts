import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from "node:crypto"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
