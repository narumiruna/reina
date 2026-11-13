import type { Api, AuthType, Model, Provider } from "@earendil-works/pi-ai"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { type AuthMethodDetails, endpoint, type SupportedApi, supportedApis } from "./schema.js"

export interface CatalogProvider {
  id: string
  name: string
  authMethods: AuthType[]
  authDetails: AuthMethodDetails
  models: {
    id: string
    name: string
    api: SupportedApi
    baseUrl: string
    contextWindow: number
    maxTokens: number
  }[]
}

// SDK 1.5.0: these methods do not require a local callback listener.
const authorizationHosts: Readonly<Record<string, readonly string[]>> = {
  "openai-codex": ["auth.openai.com"],
  anthropic: ["claude.ai"],
  "github-copilot": ["github.com"],
  "kimi-coding": ["auth.kimi.com"],
  meta: ["auth.meta.com"],
  xai: ["auth.x.ai"],
}

// Static factories only: never refresh models, resolve auth, or import host credentials.
const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]))

export function providerAuthMethods(provider: Provider): AuthType[] {
  if (provider.id === "radius" || !provider.getModels().some(usableModel)) return []
  const methods: AuthType[] = []
  if (authorizationHosts[provider.id] && provider.auth.oauth) methods.push("oauth")
  if (provider.auth.apiKey?.login) methods.push("api_key")
  return methods
}

function displayText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value.trim() === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  )
}

/** Project labels explicitly: never return SDK auth handlers or credential data. */
export function providerAuthDetails(provider: Provider): AuthMethodDetails {
  const details: AuthMethodDetails = {}
  for (const type of providerAuthMethods(provider)) {
    const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey
    if (!method || !displayText(method.name)) continue
    details[type] = { name: method.name }
    if (type === "oauth" && provider.auth.oauth) {
      const oauth = provider.auth.oauth
      if (displayText(oauth.loginLabel)) details[type].loginLabel = oauth.loginLabel
      if (typeof oauth.isSubscription === "boolean")
        details[type].isSubscription = oauth.isSubscription
    }
  }
  return details
}

function usableModel(model: Model<Api>): boolean {
  return (
    (model.type === undefined || model.type === "chat") &&
    model.input.includes("text") &&
    supportedApis.includes(model.api as SupportedApi) &&
    endpoint(model.baseUrl) &&
    !/[{}]/.test(model.baseUrl) &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(model.id) &&
    model.name.length > 0 &&
    model.name.length <= 100 &&
    !/[\p{Cc}\p{Cf}]/u.test(model.name) &&
    Number.isSafeInteger(model.contextWindow) &&
    model.contextWindow >= 4096 &&
    model.contextWindow <= 4_000_000 &&
    Number.isSafeInteger(model.maxTokens) &&
    model.maxTokens >= 256
  )
}

export function getBuiltinProvider(id: string): Provider | undefined {
  return providers.get(id)
}

/** Return the complete SDK model, including headers and compatibility metadata. */
export function getBuiltinModel(providerId: string, modelId: string): Model<Api> | undefined {
  return providers
    .get(providerId)
    ?.getModels()
    .find((model) => model.id === modelId && usableModel(model))
}

/** Public metadata only. Mixed-protocol providers retain each model's endpoint and API. */
export function catalogProviders(): CatalogProvider[] {
  const result: CatalogProvider[] = []
  for (const provider of providers.values()) {
    const authMethods = providerAuthMethods(provider)
    if (!authMethods.length) continue
    const models = provider
      .getModels()
      .filter(usableModel)
      .map((model) => ({
        id: model.id,
        name: model.name,
        api: model.api as SupportedApi,
        baseUrl: model.baseUrl,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }))
    if (models.length)
      result.push({
        id: provider.id,
        name: provider.name,
        authMethods,
        authDetails: providerAuthDetails(provider),
        models,
      })
  }
  return result
}

/** SDK 1.5.0 reads these host overrides outside AuthContext, including during refresh. */
export function assertProviderEnvironment(providerId: string): void {
  if (
    providerId === "kimi-coding" &&
    (process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST)
  ) {
    throw new Error("provider_auth_unsupported_environment")
  }
}

/** Only SDK-supplied authorization links on explicit public HTTPS hosts are allowed. */
export function isAllowedAuthorizationUrl(providerId: string, value: string): boolean {
  if (value.length > 4096 || value.trim() !== value || /[\p{Cc}\p{Cf}\\]/u.test(value)) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      ![...url.searchParams.keys()].some((key) =>
        /^(access_token|refresh_token|id_token|client_secret|password|authorization)$/i.test(key),
      ) &&
      (authorizationHosts[providerId]?.includes(url.hostname) ?? false)
    )
  } catch {
    return false
  }
}
