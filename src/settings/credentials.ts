import {
  type Api,
  type Credential,
  type CredentialStore,
  createModels,
  type Model,
} from "@earendil-works/pi-ai"
import { z } from "zod"
import { withProviderAuth } from "./auth-network.js"
import { validateProviderUrl } from "./network.js"
import { assertProviderEnvironment, getBuiltinProvider } from "./providers.js"
import type { ModelRequest } from "./schema.js"

const text = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value))
const credentialSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("api_key"),
    key: text,
    env: z.record(z.string(), z.string().max(8192)).optional(),
  }),
  z
    .object({
      type: z.literal("oauth"),
      access: text,
      refresh: text,
      expires: z.number().finite().positive(),
    })
    .passthrough(),
])

/** The SDK can add provider-specific OAuth fields; retain them inside the encrypted envelope. */
export function validateCredential(value: unknown): Credential {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 131_072)
    throw new Error("invalid_provider_credential")
  const parsed = credentialSchema.safeParse(value)
  if (!parsed.success) throw new Error("invalid_provider_credential")
  return parsed.data
}

export interface CredentialState {
  sdkProviderId?: string
  generation: string
  credential?: Credential
}
export interface CredentialPersistence {
  credentialState(id: string): CredentialState | undefined
  refreshCredential(id: string, generation: string, credential: Credential): void
  deleteCredential(id: string): void
}

const locks = new WeakMap<CredentialPersistence, Map<string, Promise<unknown>>>()
const closing = new WeakSet<CredentialPersistence>()

/** Stop new auth operations, then retain rotations that already reached the provider. */
export async function drainCredentials(settings: CredentialPersistence): Promise<void> {
  closing.add(settings)
  const queues = locks.get(settings)
  while (queues?.size) await Promise.allSettled([...queues.values()])
}

/** One SDK store per saved Reina connection; SDK IDs never merge separate accounts. */
export function connectionCredentials(
  settings: CredentialPersistence,
  id: string,
  generation: string,
): CredentialStore {
  let queues = locks.get(settings)
  if (!queues) {
    queues = new Map()
    locks.set(settings, queues)
  }
  const state = (providerId: string) => {
    const current = settings.credentialState(id)
    if (!current || current.generation !== generation || current.sdkProviderId !== providerId)
      throw new Error("provider_credential_changed")
    return current
  }
  const serialized = async <T>(
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> => {
    if (closing.has(settings)) throw new Error("provider_credentials_closing")
    const prior = queues.get(id) ?? Promise.resolve()
    const task = prior
      .catch(() => {})
      .then(async () => {
        signal?.throwIfAborted()
        return action()
      })
    queues.set(id, task)
    try {
      return await task
    } finally {
      if (queues.get(id) === task) queues.delete(id)
    }
  }
  return {
    async read(providerId, options) {
      if (closing.has(settings)) throw new Error("provider_credentials_closing")
      options?.signal?.throwIfAborted()
      return state(providerId).credential
    },
    async list(options) {
      options?.signal?.throwIfAborted()
      const current = settings.credentialState(id)
      if (!current || current.generation !== generation || !current.sdkProviderId) return []
      return current.credential
        ? [{ providerId: current.sdkProviderId, type: current.credential.type }]
        : []
    },
    async modify(providerId, update, options) {
      return serialized(options?.signal, async () => {
        const current = state(providerId).credential
        const next = await withProviderAuth(providerId, () => update(current))
        options?.signal?.throwIfAborted()
        state(providerId)
        if (next !== undefined) settings.refreshCredential(id, generation, validateCredential(next))
        return state(providerId).credential
      })
    },
    async delete(providerId, options) {
      await serialized(options?.signal, async () => {
        state(providerId)
        settings.deleteCredential(id)
      })
    },
  }
}

/** Bind refresh to a logical credential generation, not to a token that can expire during a job. */
export function modelRequestResolver(
  settings: CredentialPersistence,
  id: string,
  generation: string,
  model: Model<Api>,
): (signal: AbortSignal) => Promise<ModelRequest> {
  const provider = getBuiltinProvider(model.provider)
  if (!provider) throw new Error("provider_not_found")
  const credentials = connectionCredentials(settings, id, generation)
  const models = createModels({
    credentials,
    authContext: { env: async () => undefined, fileExists: async () => false },
  })
  models.setProvider(provider)
  const snapshot = structuredClone(model)
  let destination: string | undefined
  return async (signal) => {
    try {
      signal.throwIfAborted()
      const credential = await credentials.read(provider.id, { signal })
      if (!credential) throw new Error("provider_credential_required")
      if (
        provider.filterModels &&
        !provider.filterModels([snapshot], credential).some((item) => item.id === snapshot.id)
      )
        throw new Error("model_not_available")
      assertProviderEnvironment(provider.id)
      const resolution = await withProviderAuth(provider.id, () =>
        models.getAuth(snapshot, { signal }),
      )
      signal.throwIfAborted()
      const refreshed = await credentials.read(provider.id, { signal })
      if (!refreshed || (refreshed.type === "oauth" && refreshed.expires <= Date.now()))
        throw new Error("provider_credential_required")
      if (
        provider.filterModels &&
        !provider.filterModels([snapshot], refreshed).some((item) => item.id === snapshot.id)
      )
        throw new Error("model_not_available")
      if (
        !resolution ||
        (!resolution.auth.apiKey &&
          !Object.entries(resolution.auth.headers ?? {}).some(
            ([name, value]) =>
              /^(authorization|x-api-key|cf-aig-authorization)$/i.test(name) && Boolean(value),
          ))
      )
        throw new Error("provider_credential_required")
      const baseUrl = (resolution.auth.baseUrl ?? snapshot.baseUrl).replace(/\/+$/, "")
      validateProviderUrl(baseUrl)
      const expected = new URL(snapshot.baseUrl)
      const actual = new URL(baseUrl)
      if (provider.id === "github-copilot") {
        if (
          !/^api\.(?:individual|business|enterprise)\.githubcopilot\.com$/.test(actual.hostname) ||
          actual.port ||
          actual.pathname !== "/"
        )
          throw new Error("invalid_provider_url")
      } else if (
        actual.origin !== expected.origin ||
        actual.pathname.replace(/\/+$/, "") !== expected.pathname.replace(/\/+$/, "")
      ) {
        throw new Error("invalid_provider_url")
      }
      if (destination !== undefined && destination !== baseUrl)
        throw new Error("provider_credential_changed")
      destination = baseUrl
      return {
        model: { ...structuredClone(snapshot), baseUrl },
        auth: resolution.auth,
        env: resolution.env ?? {},
      }
    } catch {
      // SDK errors can include token endpoint bodies. Never forward those errors.
      throw new Error("provider_auth_required")
    }
  }
}
