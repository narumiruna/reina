import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Provider } from "@earendil-works/pi-ai"
import { describe, expect, it, vi } from "vitest"
import {
  catalogProviders,
  getBuiltinProvider,
  providerAuthDetails,
  providerAuthMethods,
} from "../src/settings/providers.js"
import { SettingsStore } from "../src/settings/store.js"

function anthropic() {
  const provider = getBuiltinProvider("anthropic")
  const apiKey = provider?.auth.apiKey
  const oauth = provider?.auth.oauth
  if (!provider || !apiKey || !oauth) throw new Error("missing_fixture_provider")
  return { provider, apiKey, oauth }
}

describe("SDK terminology metadata", () => {
  it("preserves the existing provider/method/model catalog and adds only explicit SDK labels", () => {
    for (const entry of catalogProviders()) {
      const provider = getBuiltinProvider(entry.id)
      if (!provider) throw new Error("missing_fixture_provider")
      expect(entry.name).toBe(provider.name)
      expect(entry.authMethods).toEqual(providerAuthMethods(provider))
      expect(Object.keys(entry.authDetails)).toEqual(entry.authMethods)
      for (const type of entry.authMethods) {
        const source = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey
        const details = entry.authDetails[type]
        expect(details?.name).toBe(source?.name)
        expect(
          Object.keys(details ?? {}).every((key) =>
            ["name", "loginLabel", "isSubscription"].includes(key),
          ),
        ).toBe(true)
        if (type === "oauth") {
          expect(details?.loginLabel).toBe(provider.auth.oauth?.loginLabel)
          expect(details?.isSubscription).toBe(provider.auth.oauth?.isSubscription)
        } else expect(details).toEqual({ name: source?.name })
      }
      for (const model of entry.models) {
        const native = provider.getModels().find((item) => item.id === model.id)
        expect(native).toMatchObject(model)
      }
    }
  })

  it("does not expose unsupported account methods or alias provider and authentication-method names", () => {
    const entries = catalogProviders()
    for (const id of ["openai", "openrouter"]) {
      const entry = entries.find((item) => item.id === id)
      expect(entry?.authMethods).toEqual(["api_key"])
      expect(entry?.authDetails.oauth).toBeUndefined()
    }
    const codex = entries.find((item) => item.id === "openai-codex")
    expect(codex).toMatchObject({
      name: "OpenAI Codex (legacy)",
      authMethods: ["oauth"],
      authDetails: { oauth: { name: "OpenAI (ChatGPT Plus/Pro)", isSubscription: true } },
    })
    const xai = entries.find((item) => item.id === "xai")
    expect(xai?.name).toBe("xAI")
    expect(xai?.authDetails.oauth?.loginLabel).toBe("Sign in with SuperGrok or X Premium")
  })

  it("projects labels without executing handlers or serializing credential/request-auth data", () => {
    const base = anthropic()
    const login = vi.fn(async () => {
      throw new Error("must_not_login")
    })
    const resolve = vi.fn(async () => {
      throw new Error("must_not_resolve")
    })
    const refresh = vi.fn(async () => {
      throw new Error("must_not_refresh")
    })
    const toAuth = vi.fn(async () => {
      throw new Error("must_not_export_auth")
    })
    const apiKey = { ...base.apiKey, login, resolve, key: "private-fixture-key" }
    const oauth = {
      ...base.oauth,
      login,
      refresh,
      toAuth,
      access: "private-fixture-access",
      refreshToken: "private-fixture-refresh",
      headers: { authorization: "private-fixture-header" },
    }
    const provider: Provider = { ...base.provider, auth: { apiKey, oauth } }
    const details = providerAuthDetails(provider)
    expect(details).toEqual({
      oauth: { name: base.oauth.name, isSubscription: true },
      api_key: { name: base.apiKey.name },
    })
    expect(JSON.stringify(details)).not.toContain("private-fixture")
    for (const operation of [login, resolve, refresh, toAuth])
      expect(operation).not.toHaveBeenCalled()
  })

  it.each([true, false, undefined])(
    "preserves explicit subscription metadata %s without assuming all OAuth is a subscription",
    (isSubscription) => {
      const base = anthropic()
      const provider: Provider = {
        ...base.provider,
        auth: { ...base.provider.auth, oauth: { ...base.oauth, isSubscription } },
      }
      const details = providerAuthDetails(provider)
      expect(details.oauth?.isSubscription).toBe(isSubscription)
      expect(Object.hasOwn(details.oauth ?? {}, "isSubscription")).toBe(
        isSubscription !== undefined,
      )
    },
  )

  it("omits malformed or oversized optional labels and invalid method names", () => {
    const base = anthropic()
    const provider: Provider = {
      ...base.provider,
      auth: { ...base.provider.auth, oauth: { ...base.oauth, loginLabel: "invalid\nlabel" } },
    }
    expect(providerAuthDetails(provider).oauth).toEqual({
      name: base.oauth.name,
      isSubscription: true,
    })
    provider.auth.oauth = { ...base.oauth, name: "x".repeat(201) }
    expect(providerAuthDetails(provider).oauth).toBeUndefined()
  })
})

it("enumerates saved-connection labels without migrating or modifying credential/model/session state", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "reina-terminology-"))
  const store = new SettingsStore(directory, "b".repeat(64))
  const database = new DatabaseSync(path.join(directory, "settings.sqlite"))
  try {
    const id = store.saveBuiltinCredential("anthropic", {
      type: "api_key",
      key: "private-fixture-key",
    })
    const other = store.saveBuiltinCredential("anthropic", {
      type: "oauth",
      access: "private-fixture-access",
      refresh: "private-fixture-refresh",
      expires: Date.now() + 3_600_000,
    })
    const native = anthropic().provider.getModels()[0]
    const modelId = store.saveModel(id, {
      modelId: native.id,
      name: native.name,
      contextWindow: native.contextWindow,
      maxTokens: 4096,
    })
    store.selectModel(modelId)
    const session = store.createSession("fixture", "Fixture", ["reina-admins"])
    const before = database.prepare("SELECT * FROM providers ORDER BY id").all()
    const revision = store.selection()?.modelRevision
    const entries = store.providers()
    expect(entries.map((entry) => entry.id).sort()).toEqual([id, other].sort())
    expect(entries.every((entry) => entry.sdkProviderId === "anthropic")).toBe(true)
    expect(entries.map((entry) => entry.authType).sort()).toEqual(["api_key", "oauth"])
    expect(entries[0].authDetails).toEqual(entries[1].authDetails)
    expect(entries[0].authDetails?.oauth?.isSubscription).toBe(true)
    expect(JSON.stringify(entries)).not.toContain("private-fixture")
    expect(database.prepare("SELECT * FROM providers ORDER BY id").all()).toEqual(before)
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(3)
    expect(store.selectedModelId()).toBe(modelId)
    expect(store.selection()?.modelRevision).toBe(revision)
    expect(store.model(modelId)?.providerId).toBe(id)
    expect(store.session(session.token)?.csrfToken).toBe(session.csrfToken)
  } finally {
    database.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("keeps explicit form labels, stable DOM identities, and separate model-save/selection wording", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8")
  for (const phrase of [
    "Configure provider",
    "Select authentication method",
    "Sign in with an account",
    "Sign in with an API key",
    "Add custom provider",
    "Select model",
    "Save model",
    "Maximum output tokens setting",
  ])
    expect(html).toContain(phrase)
  for (const id of [
    "add-provider",
    "provider-dialog",
    "auth-method-form",
    "provider-preset",
    "provider-api",
    "model-form",
    "model-output",
    "logout-form",
  ])
    expect(html).toContain(`id="${id}"`)
  expect(html).toContain('action="/api/provider-setups"')
  expect(html).toContain('action="/api/providers"')
  expect(html).toContain('action="/api/models"')
  expect(html).toContain('value="oauth"')
  expect(html).toContain('value="api_key"')
  expect(html).toContain('aria-describedby="provider-api-hint"')
})
