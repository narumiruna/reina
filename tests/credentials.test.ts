import { createCipheriv, generateKeyPairSync, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Credential, OAuthCredential } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  connectionCredentials,
  drainCredentials,
  validateCredential,
} from "../src/settings/credentials.js"
import { getBuiltinModel, getBuiltinProvider } from "../src/settings/providers.js"
import { SettingsStore } from "../src/settings/store.js"

const master = "d".repeat(64)
const oauth = (access = "fixture-access", expires = Date.now() + 3_600_000): OAuthCredential => ({
  type: "oauth",
  access,
  refresh: "fixture-refresh",
  expires,
})
let directory: string
let store: SettingsStore
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "reina-credentials-"))
  store = new SettingsStore(directory, master)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
function native(providerId: string, api?: string) {
  const model = getBuiltinProvider(providerId)
    ?.getModels()
    .find((item) => (!api || item.api === api) && getBuiltinModel(providerId, item.id))
  if (!model) throw new Error("missing_fixture_model")
  return model
}
function select(providerId = "anthropic", credential: Credential = oauth()) {
  const id = store.saveBuiltinCredential(providerId, credential)
  const model = native(providerId)
  const modelId = store.saveModel(id, {
    modelId: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: Math.min(4096, model.maxTokens),
  })
  store.selectModel(modelId)
  const selection = store.selection()
  if (!selection?.resolveModelRequest) throw new Error("missing_fixture_selection")
  return { id, modelId, selection, resolve: selection.resolveModelRequest }
}
function oauthMethod(providerId: string) {
  const method = getBuiltinProvider(providerId)?.auth.oauth
  if (!method) throw new Error("missing_fixture_oauth")
  return method
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const signal = () => new AbortController().signal

describe("typed encrypted provider credentials", () => {
  it.each(["openai-codex", "anthropic", "github-copilot", "kimi-coding", "meta", "xai"])(
    "persists %s account credentials without returning tokens",
    (providerId) => {
      const id = store.saveBuiltinCredential(providerId, {
        ...oauth(),
        accountMetadata: { fixture: true },
      })
      expect(store.credentialState(id)?.credential).toMatchObject({
        ...oauth(),
        expires: expect.any(Number),
        accountMetadata: { fixture: true },
      })
      expect(store.providers()[0]).toMatchObject({
        id,
        sdkProviderId: providerId,
        authType: "oauth",
        hasCredential: true,
        hasApiKey: false,
      })
      const publicData = JSON.stringify(store.providers())
      expect(publicData).not.toContain("fixture-access")
      expect(publicData).not.toContain("fixture-refresh")
      for (const file of ["settings.sqlite", "settings.sqlite-wal"]) {
        const bytes = readFileSync(path.join(directory, file))
        expect(bytes.includes(Buffer.from("fixture-access"))).toBe(false)
        expect(bytes.includes(Buffer.from("fixture-refresh"))).toBe(false)
      }
      store.close()
      store = new SettingsStore(directory, master)
      expect(store.credentialState(id)?.credential).toMatchObject({
        access: "fixture-access",
        refresh: "fixture-refresh",
      })
    },
  )

  it("isolates two entries for the same SDK provider and preserves provider configuration", async () => {
    const first = select("anthropic", {
      type: "api_key",
      key: "first-fixture-key",
      env: { FIXTURE: "private-config" },
    })
    const second = select("anthropic", { type: "api_key", key: "second-fixture-key" })
    expect((await first.resolve(signal())).auth.apiKey).toBe("first-fixture-key")
    expect((await second.resolve(signal())).auth.apiKey).toBe("second-fixture-key")
    expect(store.credentialState(first.id)?.credential).toMatchObject({
      env: { FIXTURE: "private-config" },
    })
    expect(JSON.stringify(store.providers())).not.toContain("private-config")
  })

  it("rejects malformed credentials and unsupported authentication methods without writes", () => {
    for (const credential of [
      { type: "oauth", access: "a", refresh: "r", expires: Infinity },
      { type: "oauth", access: "a", refresh: "", expires: 1 },
      { type: "api_key", key: "key\n" },
      { type: "api_key", key: " padded " },
    ])
      expect(() => validateCredential(credential)).toThrow("invalid_provider_credential")
    expect(() =>
      store.saveBuiltinCredential("openai-codex", { type: "api_key", key: "key" }),
    ).toThrow("provider_auth_method_unavailable")
    expect(() => store.saveBuiltinCredential("openrouter", oauth())).toThrow(
      "provider_auth_method_unavailable",
    )
    expect(store.providers()).toEqual([])
  })

  it("updates only the intended SDK entry and requires the original generation", () => {
    const first = select()
    const generation = store.credentialState(first.id)?.generation
    store.saveBuiltinCredential("anthropic", oauth("new-account"), first.id, generation)
    expect(store.selectedModelId()).toBe(first.modelId)
    expect(store.credentialState(first.id)?.credential).toMatchObject({ access: "new-account" })
    expect(store.selection()?.modelRevision).not.toBe(first.selection.modelRevision)
    expect(() =>
      store.saveBuiltinCredential("anthropic", oauth("stale"), first.id, generation),
    ).toThrow("provider_credential_changed")
    expect(() =>
      store.saveProvider(
        {
          name: "Escape",
          api: "openai-completions",
          baseUrl: "https://other.example",
          apiKey: "key",
        },
        first.id,
      ),
    ).toThrow("builtin_provider_requires_setup")
  })

  it("removal clears selection but retains the provider and its models", async () => {
    const entry = select()
    store.deleteCredential(entry.id)
    expect(store.selectedModelId()).toBeNull()
    expect(store.providers()[0]).toMatchObject({ hasCredential: false, sdkProviderId: "anthropic" })
    expect(store.providers()[0].models).toHaveLength(1)
    expect(() => store.selectModel(entry.modelId)).toThrow("provider_credential_required")
    await expect(entry.resolve(signal())).rejects.toThrow(/^provider_auth_required$/)
  })

  it("uses each native model API in a mixed-protocol provider", () => {
    const id = store.saveBuiltinCredential("github-copilot", oauth())
    for (const api of ["anthropic-messages", "openai-responses", "openai-completions"]) {
      const model = native("github-copilot", api)
      const mid = store.saveModel(id, {
        modelId: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: Math.min(4096, model.maxTokens),
      })
      store.selectModel(mid)
      expect(store.selection()).toMatchObject({
        modelApi: api,
        modelProvider: "github-copilot",
        modelUrl: model.baseUrl,
      })
    }
  })

  it("enforces native model eligibility and limits before selection", () => {
    const model = native("github-copilot")
    const id = store.saveBuiltinCredential("github-copilot", { ...oauth(), availableModelIds: [] })
    const mid = store.saveModel(id, {
      modelId: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: 4096,
    })
    expect(() => store.selectModel(mid)).toThrow("model_not_available")
    expect(() =>
      store.saveModel(id, {
        modelId: "unknown-fixture-model",
        name: "Unknown",
        contextWindow: 4096,
        maxTokens: 256,
      }),
    ).toThrow("model_not_available")
    expect(() =>
      store.saveModel(id, {
        modelId: model.id,
        name: model.name,
        contextWindow: 4_000_000,
        maxTokens: 4096,
      }),
    ).toThrow("model_limits_exceeded")
  })
})

describe("serialized SDK auth resolution", () => {
  it("refreshes an expired token once across independent resolvers and preserves the logical generation", async () => {
    const entry = select("anthropic", oauth("expired", 1))
    const second = store.selection()?.resolveModelRequest
    if (!second) throw new Error("missing_fixture_resolver")
    const refresh = vi
      .spyOn(oauthMethod("anthropic"), "refresh")
      .mockResolvedValue({ ...oauth("rotated"), refresh: "rotated-refresh" })
    const before = store.credentialState(entry.id)?.generation
    const results = await Promise.all([entry.resolve(signal()), second(signal())])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(results.map((item) => item.auth.apiKey)).toEqual(["rotated", "rotated"])
    expect(store.credentialState(entry.id)).toMatchObject({
      generation: before,
      credential: { access: "rotated", refresh: "rotated-refresh" },
    })
    expect(store.selection()?.modelRevision).toBe(entry.selection.modelRevision)
  })

  it("persists a started rotation during cancellation before shutdown closes storage", async () => {
    const entry = select("anthropic", oauth("expired", 1))
    const blocked = deferred<OAuthCredential>()
    const refresh = vi.spyOn(oauthMethod("anthropic"), "refresh").mockReturnValue(blocked.promise)
    const controller = new AbortController()
    const pending = entry.resolve(controller.signal)
    const rejected = expect(pending).rejects.toThrow(/^provider_auth_required$/)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    controller.abort()
    await rejected
    let drained = false
    const shutdown = drainCredentials(store).then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    blocked.resolve({ ...oauth("shutdown-access"), refresh: "shutdown-refresh" })
    await shutdown
    expect(store.credentialState(entry.id)?.credential).toMatchObject({
      access: "shutdown-access",
      refresh: "shutdown-refresh",
    })
    await expect(entry.resolve(signal())).rejects.toThrow(/^provider_auth_required$/)
  })

  it("rechecks model eligibility after refresh changes the allowed models", async () => {
    const model = native("github-copilot")
    const entry = select("github-copilot", {
      ...oauth("expired", 1),
      availableModelIds: [model.id],
    })
    vi.spyOn(oauthMethod("github-copilot"), "refresh").mockResolvedValue({
      ...oauth("refreshed"),
      availableModelIds: [],
    })
    await expect(entry.resolve(signal())).rejects.toThrow(/^provider_auth_required$/)
    expect(store.credentialState(entry.id)?.credential).toMatchObject({
      access: "refreshed",
      availableModelIds: [],
    })
  })

  it("accepts a valid finite refreshed lifetime without requiring an impossible five-minute margin", async () => {
    const entry = select("anthropic", oauth("expired", 1))
    vi.spyOn(oauthMethod("anthropic"), "refresh").mockResolvedValue(
      oauth("short-lived", Date.now() + 60_000),
    )
    expect((await entry.resolve(signal())).auth.apiKey).toBe("short-lived")
  })

  it("does not use an already-expired token returned by refresh", async () => {
    const entry = select("anthropic", oauth("expired", 1))
    vi.spyOn(oauthMethod("anthropic"), "refresh").mockResolvedValue(oauth("still-expired", 1))
    await expect(entry.resolve(signal())).rejects.toThrow(/^provider_auth_required$/)
  })

  it("does not overwrite a new login with an old refresh result", async () => {
    const entry = select("anthropic", oauth("expired", 1))
    const blocked = deferred<OAuthCredential>()
    const refresh = vi.spyOn(oauthMethod("anthropic"), "refresh").mockReturnValue(blocked.promise)
    const pending = entry.resolve(signal())
    const rejected = expect(pending).rejects.toThrow(/^provider_auth_required$/)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    store.saveBuiltinCredential(
      "anthropic",
      oauth("new-login"),
      entry.id,
      store.credentialState(entry.id)?.generation,
    )
    blocked.resolve(oauth("stale-refresh"))
    await rejected
    expect(store.credentialState(entry.id)?.credential).toMatchObject({ access: "new-login" })
  })

  it.each(["credential", "provider"])("cannot restore a removed %s after refresh", async (kind) => {
    const entry = select("anthropic", oauth("expired", 1))
    const blocked = deferred<OAuthCredential>()
    const refresh = vi.spyOn(oauthMethod("anthropic"), "refresh").mockReturnValue(blocked.promise)
    const pending = entry.resolve(signal())
    const rejected = expect(pending).rejects.toThrow(/^provider_auth_required$/)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    if (kind === "credential") store.deleteCredential(entry.id)
    else store.deleteProvider(entry.id)
    blocked.resolve(oauth("must-not-return"))
    await rejected
    expect(store.credentialState(entry.id)?.credential).toBeUndefined()
  })

  it("keeps the prior credential and hides provider errors when refresh fails", async () => {
    const entry = select("anthropic", oauth("expired", 1))
    vi.spyOn(oauthMethod("anthropic"), "refresh").mockRejectedValue(
      new Error("raw-sensitive-provider-body"),
    )
    await expect(entry.resolve(signal())).rejects.toThrow(/^provider_auth_required$/)
    expect(store.credentialState(entry.id)?.credential).toMatchObject({
      access: "expired",
      refresh: "fixture-refresh",
    })
  })

  it("cancels queued credential mutations without writing partial rotations", async () => {
    const entry = select()
    const generation = store.credentialState(entry.id)?.generation
    if (!generation) throw new Error("missing_fixture_generation")
    const credentials = connectionCredentials(store, entry.id, generation)
    const blocked = deferred<Credential>()
    const first = credentials.modify("anthropic", () => blocked.promise)
    const controller = new AbortController()
    const second = credentials.modify("anthropic", async () => oauth("cancelled"), {
      signal: controller.signal,
    })
    const rejected = expect(second).rejects.toThrow()
    controller.abort()
    blocked.resolve(oauth("first"))
    await first
    await rejected
    expect(store.credentialState(entry.id)?.credential).toMatchObject({ access: "first" })
  })

  it("does not read ambient credentials when a saved connection has been removed", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-key-must-not-be-used")
    const entry = select()
    store.deleteCredential(entry.id)
    await expect(entry.resolve(signal())).rejects.toThrow(/^provider_auth_required$/)
  })

  it("rejects Kimi OAuth host overrides even for a fresh stored credential", async () => {
    const entry = select("kimi-coding")
    vi.stubEnv("KIMI_OAUTH_HOST", "https://unexpected.example")
    await expect(entry.resolve(signal())).rejects.toThrow(/^provider_auth_required$/)
  })

  it("rejects unapproved and changing credential-derived model destinations", async () => {
    const entry = select("github-copilot")
    const toAuth = vi.spyOn(oauthMethod("github-copilot"), "toAuth")
    toAuth.mockResolvedValue({ apiKey: "fixture", baseUrl: "https://unapproved.example" })
    await expect(entry.resolve(signal())).rejects.toThrow(/^provider_auth_required$/)
    toAuth.mockResolvedValue({
      apiKey: "fixture",
      baseUrl: "https://api.individual.githubcopilot.com",
    })
    expect((await entry.resolve(signal())).model.baseUrl).toBe(
      "https://api.individual.githubcopilot.com",
    )
    toAuth.mockResolvedValue({
      apiKey: "fixture",
      baseUrl: "https://api.business.githubcopilot.com",
    })
    await expect(entry.resolve(signal())).rejects.toThrow(/^provider_auth_required$/)
  })

  it("rejects empty request authorization instead of falling back to ambient API keys", async () => {
    const entry = select()
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-decoy")
    vi.spyOn(oauthMethod("anthropic"), "toAuth").mockResolvedValue({})
    await expect(entry.resolve(signal())).rejects.toThrow(/^provider_auth_required$/)
  })
})

it("migrates v2 raw keys atomically and preserves sessions, PEM, models and selection", () => {
  const legacyKey = "legacy-v2-fixture-key"
  const id = store.saveProvider({
    name: "Legacy",
    api: "openai-completions",
    baseUrl: "https://api.example/v1",
    apiKey: legacyKey,
  })
  const mid = store.saveModel(id, {
    name: "Legacy model",
    modelId: "legacy/model",
    contextWindow: 4096,
    maxTokens: 256,
  })
  store.selectModel(mid)
  const session = store.createSession("fixture-subject", "Fixture", ["reina-admins"])
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString()
  store.savePrivateKey(pem)
  const original = store.selection()
  store.close()
  const file = path.join(directory, "settings.sqlite")
  const db = new DatabaseSync(file)
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(master, "hex"), nonce)
  cipher.setAAD(Buffer.from(`reina:v1:provider:${id}`))
  const data = Buffer.concat([cipher.update(legacyKey, "utf8"), cipher.final()])
  const envelope = JSON.stringify({
    v: 1,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  })
  try {
    db.exec(
      `ALTER TABLE providers DROP COLUMN sdk_provider; ALTER TABLE providers DROP COLUMN credential_type; ALTER TABLE providers DROP COLUMN credential_generation; PRAGMA user_version=2;`,
    )
    db.prepare("UPDATE providers SET encrypted_key=? WHERE id=?").run(envelope, id)
  } finally {
    db.close()
  }
  expect(() => new SettingsStore(directory, "e".repeat(64))).toThrow(
    "settings_storage_or_encryption_unavailable",
  )
  const unchanged = new DatabaseSync(file)
  try {
    expect(unchanged.prepare("PRAGMA user_version").get()?.user_version).toBe(2)
    expect(
      unchanged.prepare("SELECT encrypted_key FROM providers WHERE id=?").get(id)?.encrypted_key,
    ).toBe(envelope)
    expect(
      unchanged
        .prepare("PRAGMA table_info(providers)")
        .all()
        .map((row) => row.name),
    ).not.toContain("sdk_provider")
  } finally {
    unchanged.close()
  }
  store = new SettingsStore(directory, master)
  expect(store.credentialState(id)?.credential).toEqual({ type: "api_key", key: legacyKey })
  expect(store.selectedModelId()).toBe(mid)
  expect(store.selection()).toMatchObject({ ...original, modelRevision: expect.any(String) })
  expect(store.session(session.token)).toMatchObject({
    subject: "fixture-subject",
    groups: ["reina-admins"],
  })
  expect(store.privateKey()).toBe(pem.trim())
})
