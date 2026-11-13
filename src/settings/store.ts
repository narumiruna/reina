import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { AuthType, Credential } from "@earendil-works/pi-ai"
import { privateFile } from "../jobs/store.js"
import { groupNamesSchema } from "../web/groups.js"
import { type CredentialState, modelRequestResolver, validateCredential } from "./credentials.js"
import {
  type DispatchInput,
  type DispatchSettings,
  type DispatchStatus,
  dispatchInputSchema,
  dispatchSettingsSchema,
} from "./dispatch.js"
import {
  type GitHubAppSettings,
  type GitHubAppStatus,
  type GitHubConnection,
  gitHubAppSettingsSchema,
  gitHubConnectionSchema,
} from "./github.js"
import { validateProviderUrl } from "./network.js"
import {
  getBuiltinModel,
  getBuiltinProvider,
  providerAuthDetails,
  providerAuthMethods,
} from "./providers.js"
import {
  type ModelInput,
  type ModelSelection,
  modelSchema,
  type ProviderInput,
  providerSchema,
  type SavedModel,
  type SavedProvider,
  validatePrivateKey,
} from "./schema.js"

export interface Session {
  subject: string
  name: string
  csrfToken: string
  groups: string[]
}
interface ProviderRow {
  id: string
  name: string
  api: SavedProvider["api"]
  base_url: string
  encrypted_key: string | null
  sdk_provider: string | null
  credential_type: AuthType
  credential_generation: string
}
interface ModelRow {
  id: string
  provider_id: string
  model_id: string
  name: string
  context_window: number
  max_tokens: number
}
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex")
const SESSION_MS = 8 * 60 * 60 * 1000

export class SettingsStore {
  private readonly db: DatabaseSync
  private readonly encryptionKey: Buffer

  constructor(stateDir: string, encryptionKey: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(encryptionKey)) throw new Error("invalid_encryption_key")
    if (!isAbsolute(stateDir) || stateDir !== resolve(stateDir))
      throw new Error("invalid_state_directory")
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(stateDir)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("unsafe_state_directory")
    chmodSync(stateDir, 0o700)
    const path = join(stateDir, "settings.sqlite")
    privateFile(path)
    this.encryptionKey = Buffer.from(encryptionKey, "hex")
    this.db = new DatabaseSync(path, { timeout: 0, enableForeignKeyConstraints: true })
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;",
      )
      const version = this.db.prepare("PRAGMA user_version").get()?.user_version
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3)
        throw new Error("unsupported_settings_schema")
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS providers (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, api TEXT NOT NULL, base_url TEXT NOT NULL,
            encrypted_key TEXT, sdk_provider TEXT, credential_type TEXT NOT NULL DEFAULT 'api_key',
            credential_generation TEXT NOT NULL DEFAULT ''
          ) STRICT;
          CREATE TABLE IF NOT EXISTS models (
            id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
            model_id TEXT NOT NULL, name TEXT NOT NULL, context_window INTEGER NOT NULL, max_tokens INTEGER NOT NULL,
            UNIQUE(provider_id,model_id)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS preferences (
            id INTEGER PRIMARY KEY CHECK(id=1), model_id TEXT REFERENCES models(id) ON DELETE SET NULL
          ) STRICT;
          INSERT OR IGNORE INTO preferences(id,model_id) VALUES(1,NULL);
          CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, metadata TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS sessions (
            hash TEXT PRIMARY KEY, subject TEXT NOT NULL, name TEXT NOT NULL, csrf TEXT NOT NULL,
            expires_at INTEGER NOT NULL, groups TEXT NOT NULL DEFAULT '[]'
          ) STRICT;
        `)
        if (version === 1) {
          this.db.exec(
            "ALTER TABLE sessions ADD COLUMN groups TEXT NOT NULL DEFAULT '[]'; DELETE FROM sessions;",
          )
        }
        if (version === 1 || version === 2) {
          this.db.exec(`ALTER TABLE providers ADD COLUMN sdk_provider TEXT;
            ALTER TABLE providers ADD COLUMN credential_type TEXT NOT NULL DEFAULT 'api_key';
            ALTER TABLE providers ADD COLUMN credential_generation TEXT NOT NULL DEFAULT '';`)
          for (const row of this.db.prepare("SELECT id,encrypted_key FROM providers").all()) {
            const id = String(row.id)
            const encrypted =
              row.encrypted_key === null
                ? null
                : this.encrypt(
                    `provider:${id}`,
                    JSON.stringify({
                      type: "api_key",
                      key: this.decrypt(`provider:${id}`, String(row.encrypted_key)),
                    }),
                  )
            this.db
              .prepare("UPDATE providers SET encrypted_key=?,credential_generation=? WHERE id=?")
              .run(encrypted, randomUUID(), id)
          }
        }
        this.db.exec("PRAGMA user_version=3;")
        const check = this.db
          .prepare("SELECT value FROM secrets WHERE name='encryption-check'")
          .get()
        if (check) {
          if (this.decrypt("encryption-check", String(check.value)) !== "reina-settings-v1")
            throw new Error("settings_encryption_key_mismatch")
        } else {
          this.db
            .prepare("INSERT INTO secrets VALUES(?,?,?)")
            .run("encryption-check", this.encrypt("encryption-check", "reina-settings-v1"), "{}")
        }
      })
    } catch {
      this.db.close()
      this.encryptionKey.fill(0)
      throw new Error("settings_storage_or_encryption_unavailable")
    }
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = operation()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  private encrypt(purpose: string, value: string): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce)
    cipher.setAAD(Buffer.from(`reina:v1:${purpose}`))
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
    return JSON.stringify({
      v: 1,
      nonce: nonce.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: encrypted.toString("base64"),
    })
  }

  private decrypt(purpose: string, envelope: string): string {
    try {
      const value = JSON.parse(envelope)
      if (value.v !== 1) throw new Error("invalid_envelope")
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.encryptionKey,
        Buffer.from(value.nonce, "base64"),
      )
      decipher.setAAD(Buffer.from(`reina:v1:${purpose}`))
      decipher.setAuthTag(Buffer.from(value.tag, "base64"))
      return Buffer.concat([
        decipher.update(Buffer.from(value.data, "base64")),
        decipher.final(),
      ]).toString("utf8")
    } catch {
      throw new Error("settings_decryption_failed")
    }
  }

  providers(): SavedProvider[] {
    const providers = this.db
      .prepare("SELECT * FROM providers ORDER BY name,id")
      .all() as unknown as ProviderRow[]
    const models = this.db
      .prepare("SELECT * FROM models ORDER BY name,id")
      .all() as unknown as ModelRow[]
    return providers.map((connection) => {
      const provider = connection.sdk_provider
        ? getBuiltinProvider(connection.sdk_provider)
        : undefined
      return {
        id: connection.id,
        name: connection.name,
        api: connection.api,
        baseUrl: connection.base_url,
        hasApiKey: connection.credential_type === "api_key" && connection.encrypted_key !== null,
        hasCredential: connection.encrypted_key !== null,
        authType: connection.credential_type,
        ...(connection.sdk_provider ? { sdkProviderId: connection.sdk_provider } : {}),
        ...(provider ? { authDetails: providerAuthDetails(provider) } : {}),
        models: models
          .filter((model) => model.provider_id === connection.id)
          .map((model) => this.modelView(model)),
      }
    })
  }

  private modelView(model: ModelRow): SavedModel {
    return {
      id: model.id,
      providerId: model.provider_id,
      modelId: model.model_id,
      name: model.name,
      contextWindow: model.context_window,
      maxTokens: model.max_tokens,
    }
  }

  saveProvider(input: ProviderInput, id: string = randomUUID()): string {
    const value = providerSchema.parse(input)
    validateProviderUrl(value.baseUrl)
    const existing = this.db.prepare("SELECT * FROM providers WHERE id=?").get(id) as unknown as
      | ProviderRow
      | undefined
    if (existing?.sdk_provider) throw new Error("builtin_provider_requires_setup")
    const baseUrl = value.baseUrl.replace(/\/+$/, "")
    if (existing && existing.base_url !== baseUrl && existing.encrypted_key && !value.apiKey)
      throw new Error("api_key_required_for_new_endpoint")
    if (
      !existing &&
      Number(this.db.prepare("SELECT count(*) AS count FROM providers").get()?.count) >= 50
    )
      throw new Error("provider_limit")
    const encrypted = value.apiKey
      ? this.encrypt(
          `provider:${id}`,
          JSON.stringify(validateCredential({ type: "api_key", key: value.apiKey })),
        )
      : (existing?.encrypted_key ?? null)
    const generation =
      !existing || value.apiKey || existing.api !== value.api || existing.base_url !== baseUrl
        ? randomUUID()
        : existing.credential_generation
    this.db
      .prepare(`INSERT INTO providers(id,name,api,base_url,encrypted_key,sdk_provider,credential_type,credential_generation)
      VALUES(?,?,?,?,?,NULL,'api_key',?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,api=excluded.api,base_url=excluded.base_url,encrypted_key=excluded.encrypted_key,
      credential_generation=excluded.credential_generation`)
      .run(id, value.name, value.api, baseUrl, encrypted, generation)
    return id
  }

  credentialState(id: string): CredentialState | undefined {
    const row = this.db.prepare("SELECT * FROM providers WHERE id=?").get(id) as unknown as
      | ProviderRow
      | undefined
    if (!row) return
    const credential =
      row.encrypted_key === null
        ? undefined
        : validateCredential(JSON.parse(this.decrypt(`provider:${id}`, row.encrypted_key)))
    if (credential && credential.type !== row.credential_type)
      throw new Error("invalid_provider_credential")
    return {
      sdkProviderId: row.sdk_provider ?? undefined,
      generation: row.credential_generation,
      credential,
    }
  }

  saveBuiltinCredential(
    sdkProviderId: string,
    input: Credential,
    savedProviderId?: string,
    expectedGeneration?: string,
    signal?: AbortSignal,
  ): string {
    const value = validateCredential(input)
    const provider = getBuiltinProvider(sdkProviderId)
    if (!provider || !providerAuthMethods(provider).includes(value.type))
      throw new Error("provider_auth_method_unavailable")
    const native = provider
      .getModels()
      .map((model) => getBuiltinModel(provider.id, model.id))
      .find((model) => model !== undefined)
    if (!native) throw new Error("provider_auth_method_unavailable")
    const id = savedProviderId ?? randomUUID()
    return this.transaction(() => {
      signal?.throwIfAborted()
      const existing = this.db.prepare("SELECT * FROM providers WHERE id=?").get(id) as unknown as
        | ProviderRow
        | undefined
      if (savedProviderId && !existing) throw new Error("provider_not_found")
      if (
        existing &&
        (existing.sdk_provider !== sdkProviderId ||
          existing.credential_generation !== expectedGeneration)
      )
        throw new Error("provider_credential_changed")
      if (
        !existing &&
        Number(this.db.prepare("SELECT count(*) AS count FROM providers").get()?.count) >= 50
      )
        throw new Error("provider_limit")
      this.db
        .prepare(`INSERT INTO providers(id,name,api,base_url,encrypted_key,sdk_provider,credential_type,credential_generation)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        encrypted_key=excluded.encrypted_key,credential_type=excluded.credential_type,credential_generation=excluded.credential_generation`)
        .run(
          id,
          existing?.name ?? provider.name,
          native.api,
          native.baseUrl.replace(/\/+$/, ""),
          this.encrypt(`provider:${id}`, JSON.stringify(value)),
          sdkProviderId,
          value.type,
          randomUUID(),
        )
      return id
    })
  }

  refreshCredential(id: string, generation: string, input: Credential): void {
    const credential = validateCredential(input)
    const result = this.db
      .prepare(
        "UPDATE providers SET encrypted_key=? WHERE id=? AND credential_generation=? AND credential_type=? AND encrypted_key IS NOT NULL",
      )
      .run(
        this.encrypt(`provider:${id}`, JSON.stringify(credential)),
        id,
        generation,
        credential.type,
      )
    if (result.changes !== 1) throw new Error("provider_credential_changed")
  }

  deleteCredential(id: string): void {
    this.transaction(() => {
      const result = this.db
        .prepare("UPDATE providers SET encrypted_key=NULL,credential_generation=? WHERE id=?")
        .run(randomUUID(), id)
      if (result.changes !== 1) throw new Error("provider_not_found")
      this.db
        .prepare(
          "UPDATE preferences SET model_id=NULL WHERE model_id IN (SELECT id FROM models WHERE provider_id=?)",
        )
        .run(id)
    })
  }

  deleteProvider(id: string): void {
    this.db.prepare("DELETE FROM providers WHERE id=?").run(id)
  }

  saveModel(savedConnectionId: string, input: ModelInput, id: string = randomUUID()): string {
    const value = modelSchema.parse(input)
    const connection = this.db
      .prepare("SELECT sdk_provider FROM providers WHERE id=?")
      .get(savedConnectionId)
    if (!connection) throw new Error("provider_not_found")
    if (connection.sdk_provider) {
      const native = getBuiltinModel(String(connection.sdk_provider), value.modelId)
      if (!native) throw new Error("model_not_available")
      if (value.contextWindow > native.contextWindow || value.maxTokens > native.maxTokens)
        throw new Error("model_limits_exceeded")
    }
    if (
      Number(this.db.prepare("SELECT count(*) AS count FROM models").get()?.count) >= 500 &&
      !this.db.prepare("SELECT id FROM models WHERE id=?").get(id)
    )
      throw new Error("model_limit")
    try {
      this.db
        .prepare(`INSERT INTO models VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        model_id=excluded.model_id,name=excluded.name,context_window=excluded.context_window,max_tokens=excluded.max_tokens`)
        .run(id, savedConnectionId, value.modelId, value.name, value.contextWindow, value.maxTokens)
    } catch {
      throw new Error("model_already_exists")
    }
    return id
  }

  model(id: string): SavedModel | undefined {
    const row = this.db.prepare("SELECT * FROM models WHERE id=?").get(id) as unknown as
      | ModelRow
      | undefined
    return row ? this.modelView(row) : undefined
  }

  deleteModel(id: string): void {
    this.db.prepare("DELETE FROM models WHERE id=?").run(id)
  }

  selectedModelId(): string | null {
    const value = this.db.prepare("SELECT model_id FROM preferences WHERE id=1").get()?.model_id
    return value === null || value === undefined ? null : String(value)
  }

  selectModel(id: string | null): void {
    if (id !== null) {
      const model = this.model(id)
      if (!model) throw new Error("model_not_found")
      const state = this.credentialState(model.providerId)
      if (!state?.credential)
        throw new Error(
          state?.sdkProviderId ? "provider_credential_required" : "provider_api_key_required",
        )
      if (state.sdkProviderId) {
        const provider = getBuiltinProvider(state.sdkProviderId)
        const native = getBuiltinModel(state.sdkProviderId, model.modelId)
        if (
          !provider ||
          !native ||
          (provider.filterModels &&
            !provider
              .filterModels([native], state.credential)
              .some((item) => item.id === native.id))
        )
          throw new Error("model_not_available")
      }
    }
    this.db.prepare("UPDATE preferences SET model_id=? WHERE id=1").run(id)
  }

  selection(): ModelSelection | undefined {
    const id = this.selectedModelId()
    if (!id) return
    const model = this.model(id)
    if (!model) return
    const provider = this.db
      .prepare("SELECT * FROM providers WHERE id=?")
      .get(model.providerId) as unknown as ProviderRow | undefined
    if (!provider?.encrypted_key) return
    const state = this.credentialState(provider.id)
    if (!state?.credential) return
    const native = provider.sdk_provider
      ? getBuiltinModel(provider.sdk_provider, model.modelId)
      : undefined
    if (provider.sdk_provider && !native) return
    const sdk = provider.sdk_provider ? getBuiltinProvider(provider.sdk_provider) : undefined
    if (
      native &&
      sdk?.filterModels &&
      !sdk.filterModels([native], state.credential).some((item) => item.id === native.id)
    )
      return
    const snapshot = native
      ? {
          ...structuredClone(native),
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        }
      : undefined
    return {
      model: model.modelId,
      modelUrl: native?.baseUrl ?? provider.base_url,
      modelKey: state.credential.type === "api_key" ? (state.credential.key ?? "") : "",
      modelApi: (native?.api ?? provider.api) as ModelSelection["modelApi"],
      modelProvider: provider.sdk_provider ?? provider.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      modelRevision: createHash("sha256")
        .update(
          JSON.stringify([
            provider.id,
            state.generation,
            snapshot ?? [provider.api, provider.base_url],
            model,
          ]),
        )
        .digest("hex"),
      ...(snapshot
        ? {
            resolveModelRequest: modelRequestResolver(
              this,
              provider.id,
              state.generation,
              snapshot,
            ),
          }
        : {}),
    }
  }

  /** Trusted secret-bearing read. Invalid saved data must not enable environment fallback. */
  githubAppSettings(): GitHubAppSettings | undefined {
    const row = this.db.prepare("SELECT value FROM secrets WHERE name='github-app-settings'").get()
    if (!row) return
    try {
      return gitHubAppSettingsSchema.parse(
        JSON.parse(this.decrypt("github-app-settings", String(row.value))),
      )
    } catch {
      throw new Error("invalid_github_app_settings")
    }
  }

  githubAppStatus(): GitHubAppStatus | undefined {
    const settings = this.githubAppSettings()
    if (!settings) return
    const { clientSecret, webhookSecret, ...status } = settings
    return {
      ...status,
      clientSecretConfigured: clientSecret.length > 0,
      webhookSecretConfigured: webhookSecret.length > 0,
    }
  }

  saveGitHubAppSettings(input: GitHubAppSettings): void {
    const result = gitHubAppSettingsSchema.safeParse(input)
    if (!result.success) throw new Error("invalid_github_app_settings")
    this.transaction(() => {
      const previous = this.githubAppSettings()
      this.db
        .prepare(
          "INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,metadata=excluded.metadata",
        )
        .run(
          "github-app-settings",
          this.encrypt("github-app-settings", JSON.stringify(result.data)),
          "{}",
        )
      if (previous && previous.appId !== result.data.appId)
        this.db.prepare("DELETE FROM secrets WHERE name='github-connection'").run()
    })
  }

  githubConnection(): GitHubConnection | undefined {
    const row = this.db.prepare("SELECT value FROM secrets WHERE name='github-connection'").get()
    if (!row) return
    try {
      return gitHubConnectionSchema.parse(
        JSON.parse(this.decrypt("github-connection", String(row.value))),
      )
    } catch {
      throw new Error("invalid_github_connection")
    }
  }

  saveGitHubConnection(input: GitHubConnection): void {
    const result = gitHubConnectionSchema.safeParse(input)
    if (!result.success) throw new Error("invalid_github_connection")
    this.transaction(() => {
      const app = this.githubAppSettings()
      if (app && app.appId !== result.data.appId) throw new Error("github_app_mismatch")
      this.db
        .prepare(
          "INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,metadata=excluded.metadata",
        )
        .run(
          "github-connection",
          this.encrypt("github-connection", JSON.stringify(result.data)),
          "{}",
        )
    })
  }

  /** Trusted secret-bearing read. Invalid saved data must not enable environment fallback. */
  dispatchSettings(): DispatchSettings | undefined {
    const row = this.db.prepare("SELECT value FROM secrets WHERE name='dispatch-settings'").get()
    if (!row) return
    try {
      return dispatchSettingsSchema.parse(
        JSON.parse(this.decrypt("dispatch-settings", String(row.value))),
      )
    } catch {
      throw new Error("invalid_dispatch_settings")
    }
  }

  dispatchStatus(): DispatchStatus | undefined {
    const settings = this.dispatchSettings()
    if (!settings) return
    const { webhookSecret, ...status } = settings
    return { ...status, webhookSecretConfigured: webhookSecret.length > 0 }
  }

  saveDispatchSettings(input: DispatchInput): void {
    const result = dispatchInputSchema.safeParse(input)
    if (!result.success) throw new Error("invalid_dispatch_settings")
    this.transaction(() => {
      let webhookSecret = result.data.webhookSecret
      if (webhookSecret === undefined) {
        const app = this.githubAppSettings()
        if (app?.appId === result.data.appId) webhookSecret = app.webhookSecret
        else {
          const previous = this.dispatchSettings()
          if (previous?.appId === result.data.appId) webhookSecret = previous.webhookSecret
        }
      }
      if (!webhookSecret) throw new Error("webhook_secret_required")
      this.db
        .prepare(
          "INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,metadata=excluded.metadata",
        )
        .run(
          "dispatch-settings",
          this.encrypt("dispatch-settings", JSON.stringify({ ...result.data, webhookSecret })),
          "{}",
        )
    })
  }

  savePrivateKey(input: string): void {
    const { pem, fingerprint } = validatePrivateKey(input)
    this.db
      .prepare(
        "INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value,metadata=excluded.metadata",
      )
      .run(
        "github-private-key",
        this.encrypt("github-private-key", pem),
        JSON.stringify({ fingerprint, uploadedAt: Date.now() }),
      )
  }

  /** Internal credential revision. Ciphertext changes detect same-value rewrites and rotation. */
  githubRevision(): string {
    const rows = this.db
      .prepare(
        "SELECT name,value FROM secrets WHERE name IN ('github-private-key','github-app-settings') ORDER BY name",
      )
      .all()
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex")
  }

  githubStatus(): { configured: boolean; fingerprint?: string; uploadedAt?: number } {
    const row = this.db
      .prepare("SELECT metadata FROM secrets WHERE name='github-private-key'")
      .get()
    return row ? { configured: true, ...JSON.parse(String(row.metadata)) } : { configured: false }
  }

  privateKey(): string | undefined {
    const row = this.db.prepare("SELECT value FROM secrets WHERE name='github-private-key'").get()
    return row ? this.decrypt("github-private-key", String(row.value)) : undefined
  }

  deletePrivateKey(): void {
    this.db.prepare("DELETE FROM secrets WHERE name='github-private-key'").run()
  }

  bindAuthContext(identity: string): void {
    const digest = createHash("sha256").update(identity).digest("hex")
    const previous = this.db.prepare("SELECT value FROM secrets WHERE name='auth-context'").get()
    if (previous && this.decrypt("auth-context", String(previous.value)) === digest) return
    this.transaction(() => {
      this.db.prepare("DELETE FROM sessions").run()
      this.db
        .prepare(
          "INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value",
        )
        .run("auth-context", this.encrypt("auth-context", digest), "{}")
    })
  }

  createSession(
    subject: string,
    name: string,
    groups: string[],
  ): { token: string; csrfToken: string } {
    const membership = groupNamesSchema.parse(groups)
    this.db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(Date.now())
    if (Number(this.db.prepare("SELECT count(*) AS count FROM sessions").get()?.count) >= 128)
      this.db
        .prepare(
          "DELETE FROM sessions WHERE hash=(SELECT hash FROM sessions ORDER BY expires_at LIMIT 1)",
        )
        .run()
    const token = randomBytes(32).toString("hex")
    const csrfToken = randomBytes(32).toString("hex")
    this.db
      .prepare("INSERT INTO sessions(hash,subject,name,csrf,expires_at,groups) VALUES(?,?,?,?,?,?)")
      .run(
        tokenHash(token),
        subject,
        name.slice(0, 200),
        csrfToken,
        Date.now() + SESSION_MS,
        JSON.stringify(membership),
      )
    return { token, csrfToken }
  }

  session(token: string): Session | undefined {
    if (!/^[a-f0-9]{64}$/.test(token)) return
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE hash=? AND expires_at>?")
      .get(tokenHash(token), Date.now())
    if (!row) return undefined
    try {
      const membership = groupNamesSchema.safeParse(JSON.parse(String(row.groups)))
      return membership.success
        ? {
            subject: String(row.subject),
            name: String(row.name),
            csrfToken: String(row.csrf),
            groups: membership.data,
          }
        : undefined
    } catch {
      return undefined
    }
  }

  sessionForOwner(owner: string): Session | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE csrf=? AND expires_at>?")
      .get(owner, Date.now())
    if (!row) return
    try {
      const groups = groupNamesSchema.safeParse(JSON.parse(String(row.groups)))
      return groups.success
        ? {
            subject: String(row.subject),
            name: String(row.name),
            csrfToken: String(row.csrf),
            groups: groups.data,
          }
        : undefined
    } catch {
      return undefined
    }
  }

  deleteSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE hash=?").run(tokenHash(token))
  }

  close(): void {
    this.db.close()
    this.encryptionKey.fill(0)
  }
}
