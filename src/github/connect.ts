import { sign } from "node:crypto"
import { z } from "zod"
import { gitHubAppSettingsSchema } from "../settings/github.js"

export interface GitHubAppCredentials {
  appId: number
  privateKey: string
}
export interface GitHubConnectInstallation {
  id: number
  appId: number
  suspended: boolean
}
export interface GitHubConnectRepository {
  id: number
  owner: string
  name: string
  fullName: string
  archived: boolean
  disabled: boolean
  permissions: { push?: boolean; admin?: boolean; maintain?: boolean }
}
export interface GitHubConnectUser {
  id: number
  login: string
}
export interface GitHubConnectExchange {
  clientId: string
  clientSecret: string
  code: string
  verifier: string
  callbackUrl: string
}

/** Only user tokens can prove the operator's installation and repository access. */
export interface GitHubConnectTransport {
  app(
    credentials: GitHubAppCredentials,
    signal: AbortSignal,
  ): Promise<{ id: number; clientId: string; slug: string }>
  exchange(input: GitHubConnectExchange, signal: AbortSignal): Promise<string>
  user(token: string, signal: AbortSignal): Promise<GitHubConnectUser>
  installations(token: string, signal: AbortSignal): Promise<GitHubConnectInstallation[]>
  repositories(
    token: string,
    installationId: number,
    signal: AbortSignal,
  ): Promise<GitHubConnectRepository[]>
  installation(
    credentials: GitHubAppCredentials,
    installationId: number,
    signal: AbortSignal,
  ): Promise<GitHubConnectInstallation>
}

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const owner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
const installationSchema = z.object({
  id,
  app_id: id,
  suspended_at: z.string().nullable(),
})
const repositorySchema = z.object({
  id,
  name: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/),
  full_name: z.string().max(140),
  owner: z.object({ login: owner }),
  archived: z.boolean(),
  disabled: z.boolean(),
  permissions: z.object({
    push: z.boolean().optional(),
    admin: z.boolean().optional(),
    maintain: z.boolean().optional(),
  }),
})
const MAX_PAGES = 10
const MAX_BODY = 2 * 1024 * 1024

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new Error("github_connect_transport_failed")
  return result.data
}

function jwt(credentials: GitHubAppCredentials): string {
  parse(id, credentials.appId)
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(credentials.appId) }),
  ).toString("base64url")
  const message = `${header}.${payload}`
  try {
    return `${message}.${sign("RSA-SHA256", Buffer.from(message), credentials.privateKey).toString("base64url")}`
  } catch {
    throw new Error("github_connect_transport_failed")
  }
}

function installation(value: z.infer<typeof installationSchema>): GitHubConnectInstallation {
  return { id: value.id, appId: value.app_id, suspended: value.suspended_at !== null }
}

/** Fixed GitHub hosts, no redirects, retries, response logging, or installation tokens. */
export class FixedGitHubConnectTransport implements GitHubConnectTransport {
  private async request(
    path: string,
    token: string | undefined,
    signal: AbortSignal,
    body?: URLSearchParams,
  ): Promise<unknown> {
    const target = body
      ? "https://github.com/login/oauth/access_token"
      : `https://api.github.com${path}`
    // All paths are made here, from validated numeric IDs and bounded page numbers.
    if (
      !body &&
      !/^\/(?:app(?:\/installations\/[1-9][0-9]*)?|user(?:\/installations(?:\/[1-9][0-9]*\/repositories)?\?per_page=100&page=[1-9][0-9]*)?)$/.test(
        path,
      )
    )
      throw new Error("github_connect_transport_failed")
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    let response: Response | undefined
    try {
      response = await fetch(target, {
        method: body ? "POST" : "GET",
        headers: {
          accept: "application/json",
          "user-agent": "reina-github-connect",
          "x-github-api-version": "2026-03-10",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        },
        ...(body ? { body: body.toString() } : {}),
        redirect: "error",
        signal: bounded,
      })
      if (!response.ok || !response.body) throw new Error("rejected")
      const declared = response.headers.get("content-length")
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY))
        throw new Error("oversized")
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_BODY) throw new Error("oversized")
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      await response?.body?.cancel().catch(() => {})
      throw new Error("github_connect_transport_failed")
    }
  }

  async app(credentials: GitHubAppCredentials, signal: AbortSignal) {
    const value = parse(
      z.object({
        id,
        client_id: gitHubAppSettingsSchema.shape.clientId,
        slug: gitHubAppSettingsSchema.shape.slug,
      }),
      await this.request("/app", jwt(credentials), signal),
    )
    return { id: value.id, clientId: value.client_id, slug: value.slug }
  }

  async exchange(input: GitHubConnectExchange, signal: AbortSignal): Promise<string> {
    const value = parse(
      z.object({
        access_token: z.string().regex(/^[A-Za-z0-9_.-]{1,4096}$/),
        token_type: z.literal("bearer"),
      }),
      await this.request(
        "",
        undefined,
        signal,
        new URLSearchParams({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          code: input.code,
          code_verifier: input.verifier,
          redirect_uri: input.callbackUrl,
        }),
      ),
    )
    // Ignore refresh tokens. The user token is held only by the bounded memory flow.
    return value.access_token
  }

  async user(token: string, signal: AbortSignal): Promise<GitHubConnectUser> {
    return parse(z.object({ id, login: owner }), await this.request("/user", token, signal))
  }

  private async pages<T>(
    path: string,
    field: string,
    schema: z.ZodType<T>,
    token: string,
    signal: AbortSignal,
  ): Promise<T[]> {
    const values: T[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = parse(
        z.object({ [field]: z.array(schema).max(100) }),
        await this.request(`${path}?per_page=100&page=${page}`, token, signal),
      )
      const batch = result[field]
      values.push(...batch)
      if (batch.length < 100) return values
    }
    // Do not silently offer an incomplete access list.
    throw new Error("github_connect_transport_failed")
  }

  async installations(token: string, signal: AbortSignal): Promise<GitHubConnectInstallation[]> {
    return (
      await this.pages("/user/installations", "installations", installationSchema, token, signal)
    ).map(installation)
  }

  async repositories(token: string, installationId: number, signal: AbortSignal) {
    parse(id, installationId)
    const values = await this.pages(
      `/user/installations/${installationId}/repositories`,
      "repositories",
      repositorySchema,
      token,
      signal,
    )
    return values.map((value) => ({
      id: value.id,
      owner: value.owner.login,
      name: value.name,
      fullName: value.full_name,
      archived: value.archived,
      disabled: value.disabled,
      permissions: value.permissions,
    }))
  }

  async installation(
    credentials: GitHubAppCredentials,
    installationId: number,
    signal: AbortSignal,
  ): Promise<GitHubConnectInstallation> {
    parse(id, installationId)
    return installation(
      parse(
        installationSchema,
        await this.request(`/app/installations/${installationId}`, jwt(credentials), signal),
      ),
    )
  }
}
