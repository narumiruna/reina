import { createHash, createPrivateKey, createPublicKey } from "node:crypto"
import type { Api, AuthType, Model, ModelAuth, OAuthAuth, ProviderEnv } from "@earendil-works/pi-ai"
import { z } from "zod"

export const customApis = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const
export const supportedApis = [...customApis, "openai-codex-responses"] as const
export type SupportedApi = (typeof supportedApis)[number]

export function endpoint(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      value.trim() === value &&
      value.length <= 2048 &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[\p{Cc}\p{Cf}]/u.test(value)
    )
  } catch {
    return false
  }
}

const name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/[\p{Cc}]/u.test(value))
export const providerSchema = z.strictObject({
  name,
  api: z.enum(customApis),
  baseUrl: z
    .string()
    .refine(endpoint, "Use an HTTPS base URL without credentials, query, or fragment"),
  apiKey: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => value.trim() === value && !/[\p{Cc}]/u.test(value))
    .optional(),
})
export const modelSchema = z.strictObject({
  modelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/),
  name,
  contextWindow: z.number().int().min(4096).max(4_000_000).default(128_000),
  maxTokens: z.number().int().min(256).max(4096).default(4096),
})
export type ProviderInput = z.infer<typeof providerSchema>
export type ModelInput = z.infer<typeof modelSchema>
export type AuthMethodInfo = Pick<OAuthAuth, "name" | "loginLabel" | "isSubscription">
export type AuthMethodDetails = Partial<Record<AuthType, AuthMethodInfo>>

export interface SavedModel extends ModelInput {
  id: string
  /** Saved connection UUID, not the SDK Provider.id. This JSON field remains stable. */
  providerId: string
}
export interface SavedProvider {
  /** Saved connection UUID. Multiple connections can use the same SDK provider. */
  id: string
  name: string
  api: SupportedApi
  baseUrl: string
  hasApiKey: boolean
  hasCredential: boolean
  authType: AuthType
  /** Read-only SDK labels, not credential or request-auth data. */
  authDetails?: AuthMethodDetails
  sdkProviderId?: string
  models: SavedModel[]
}
/** Resolved only by the trusted host; never serialize this data to a worker. */
export interface ModelRequest {
  model: Model<Api>
  auth: ModelAuth
  env?: ProviderEnv
}
export interface ModelSelection {
  model: string
  modelUrl: string
  modelKey: string
  modelApi: SupportedApi
  modelProvider: string
  contextWindow: number
  maxTokens: number
  modelRevision: string
  resolveModelRequest?: (signal: AbortSignal) => Promise<ModelRequest>
}

/** Accept only unencrypted RSA PEM keys suitable for GitHub App JWT signing. */
export function validatePrivateKey(value: string): { pem: string; fingerprint: string } {
  if (Buffer.byteLength(value) > 32_768) throw new Error("invalid_private_key")
  const pem = value.trim().replace(/\r\n/g, "\n")
  if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----\n/.test(pem)) throw new Error("invalid_private_key")
  try {
    const key = createPrivateKey({ key: pem, format: "pem", passphrase: "" })
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new Error("invalid_private_key")
    const publicKey = createPublicKey(key).export({ type: "spki", format: "der" })
    return {
      pem,
      fingerprint: `SHA256:${createHash("sha256").update(publicKey).digest("base64url")}`,
    }
  } catch {
    throw new Error("invalid_private_key")
  }
}
