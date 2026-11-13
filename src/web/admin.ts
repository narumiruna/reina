import { readFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { z } from "zod"
import { logHttpFailure } from "../http-logging.js"
import { modelCatalog } from "../settings/catalog.js"
import { modelSchema, providerSchema } from "../settings/schema.js"
import type { SettingsStore } from "../settings/store.js"
import type { Logger } from "../types.js"
import type { Auth } from "./auth.js"
import type { RuntimeStatus } from "./controller.js"
import { ProviderSetup, ProviderSetupError } from "./provider-setup.js"

const safeErrors = new Set([
  "provider_not_found",
  "model_not_found",
  "provider_api_key_required",
  "api_key_required_for_new_endpoint",
  "provider_limit",
  "model_limit",
  "model_already_exists",
  "invalid_private_key",
  "provider_address_not_public",
  "invalid_provider_url",
  "provider_credential_required",
  "provider_credential_changed",
  "invalid_provider_credential",
  "provider_auth_method_unavailable",
  "builtin_provider_requires_setup",
  "model_not_available",
  "model_limits_exceeded",
])
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res
    .writeHead(status, { "content-type": "application/json; charset=utf-8" })
    .end(JSON.stringify(value))
}
async function body(req: IncomingMessage, limit: number, contentType: string): Promise<string> {
  if (
    req.headers["content-encoding"] ||
    req.headers["content-type"]?.split(";")[0].trim() !== contentType
  )
    throw new HttpError(415, "invalid_content_type")
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > limit) throw new HttpError(413, "payload_too_large")
    chunks.push(Buffer.from(chunk))
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
}
async function input(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse(await body(req, 65_536, "application/json"))
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, "invalid_input")
  }
}

const setupInput = z.strictObject({
  providerId: z.string().min(1).max(100),
  authType: z.enum(["api_key", "oauth"]),
  savedProviderId: z.uuid().optional(),
  confirmPolicyChanges: z.boolean().optional(),
})

export class AdminWeb {
  private readonly assets = new Map<string, Promise<Buffer>>()
  private readonly setups: ProviderSetup
  constructor(
    private readonly settings: SettingsStore,
    private readonly auth: Auth,
    private readonly origin: string,
    private readonly runtime: () => RuntimeStatus,
    private readonly changed: () => void,
    private readonly log: Logger,
    setups?: ProviderSetup,
  ) {
    this.setups =
      setups ??
      new ProviderSetup({
        isOwnerActive: (owner) => this.auth.ownerActive(owner),
        commit: async (value, signal) => {
          signal.throwIfAborted()
          const id = this.settings.saveBuiltinCredential(
            value.providerId,
            value.credential,
            value.savedProviderId,
            value.expectedGeneration,
            signal,
          )
          this.changed()
          return id
        },
      })
  }

  close(): void {
    this.setups.close()
  }

  private error(req: IncomingMessage, res: ServerResponse, error: unknown): void {
    if (error instanceof ProviderSetupError) json(res, error.status, { error: error.code })
    else if (error instanceof z.ZodError) {
      json(res, 400, {
        error: "invalid_input",
        fields: [...new Set(error.issues.map((issue) => String(issue.path[0] ?? "input")))],
      })
    } else if (error instanceof HttpError) json(res, error.status, { error: error.code })
    else if (error instanceof Error && safeErrors.has(error.message))
      json(res, 400, { error: error.message })
    else {
      logHttpFailure(this.log, req, "settings_unavailable", 500)
      json(res, 500, { error: "settings_unavailable" })
    }
  }

  private async asset(res: ServerResponse, path: string, type: string): Promise<void> {
    let data = this.assets.get(path)
    if (!data) {
      data = readFile(new URL(`../../public/${path}`, import.meta.url))
      this.assets.set(path, data)
    }
    res.writeHead(200, { "content-type": `${type}; charset=utf-8` }).end(await data)
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    res.setHeader("cache-control", "no-store")
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    )
    res.setHeader("x-content-type-options", "nosniff")
    res.setHeader("referrer-policy", "no-referrer")
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()")
    if (this.origin.startsWith("https:"))
      res.setHeader("strict-transport-security", "max-age=31536000")
    if (req.headers.host !== new URL(this.origin).host) {
      json(res, 421, { error: "invalid_host" })
      return true
    }
    if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.length > 4096) {
      json(res, 400, { error: "invalid_request" })
      return true
    }
    const url = new URL(req.url, this.origin)
    const logoutOwner =
      url.pathname === "/auth/logout" ? this.auth.session(req)?.csrfToken : undefined
    if (await this.auth.handle(req, res, url)) {
      if (logoutOwner && req.method === "POST" && res.statusCode === 200)
        this.setups.cancelOwner(logoutOwner)
      return true
    }
    if (req.method === "GET" && url.pathname === "/assets/style.css") {
      await this.asset(res, "style.css", "text/css")
      return true
    }
    if (req.method === "GET" && url.pathname === "/assets/app.js") {
      await this.asset(res, "app.js", "text/javascript")
      return true
    }
    if (req.method === "GET" && url.pathname === "/login") {
      if (this.auth.session(req)) res.writeHead(303, { location: "/" }).end()
      else await this.asset(res, "login.html", "text/html")
      return true
    }
    if (url.pathname === "/api/github/webhooks") return false
    if (url.pathname !== "/" && !url.pathname.startsWith("/api/")) return false
    const session = this.auth.session(req)
    if (!session) {
      if (url.pathname === "/") res.writeHead(303, { location: "/login" }).end()
      else json(res, 401, { error: "unauthorized" })
      req.resume()
      return true
    }
    if (req.method === "GET" && url.pathname === "/") {
      await this.asset(res, "index.html", "text/html")
      return true
    }
    if (req.method === "GET" && url.pathname === "/api/settings") {
      json(res, 200, {
        providers: this.settings.providers(),
        selectedModelId: this.settings.selectedModelId(),
        github: this.settings.githubStatus(),
        runtime: this.runtime(),
        user: { name: session.name },
        csrfToken: session.csrfToken,
      })
      return true
    }
    if (req.method === "GET" && url.pathname === "/api/catalog") {
      json(res, 200, modelCatalog())
      return true
    }
    const setup = url.pathname.match(/^\/api\/provider-setups\/([a-f0-9-]{36})(\/responses)?$/)
    if (req.method === "GET" && setup && !setup[2]) {
      try {
        json(res, 200, this.setups.get(session.csrfToken, setup[1]))
      } catch (error) {
        this.error(req, res, error)
      }
      return true
    }
    if (!["POST", "PUT", "DELETE"].includes(req.method ?? "")) {
      json(res, 404, { error: "not_found" })
      return true
    }
    if (!this.auth.checkMutation(req, session)) {
      json(res, 403, { error: "csrf_failed" })
      req.resume()
      return true
    }
    try {
      if (url.pathname === "/api/provider-setups" && req.method === "POST") {
        const value = setupInput.parse(await input(req))
        const existing = value.savedProviderId
          ? this.settings.credentialState(value.savedProviderId)
          : undefined
        if (value.savedProviderId && !existing) throw new HttpError(404, "provider_not_found")
        if (existing && existing.sdkProviderId !== value.providerId)
          throw new HttpError(400, "invalid_input")
        json(
          res,
          200,
          this.setups.start(session.csrfToken, {
            ...value,
            expectedGeneration: existing?.generation,
          }),
        )
        return true
      }
      if (setup && req.method === "POST" && setup[2]) {
        const response = z
          .strictObject({ promptId: z.uuid(), value: z.string().max(16_384) })
          .parse(await input(req))
        json(
          res,
          200,
          this.setups.respond(session.csrfToken, setup[1], response.promptId, response.value),
        )
        return true
      }
      if (setup && req.method === "DELETE" && !setup[2]) {
        this.setups.cancel(session.csrfToken, setup[1])
        json(res, 200, { ok: true })
        return true
      }
      const id = await this.mutate(req, url.pathname)
      this.changed()
      json(res, 200, { ok: true, ...(id ? { id } : {}) })
    } catch (error) {
      this.error(req, res, error)
    }
    return true
  }

  private async mutate(req: IncomingMessage, path: string): Promise<string | undefined> {
    if (path === "/api/providers" && req.method === "POST")
      return this.settings.saveProvider(providerSchema.parse(await input(req)))
    const credential = path.match(/^\/api\/providers\/([a-f0-9-]{36})\/credential$/)
    if (credential && req.method === "DELETE") {
      this.settings.deleteCredential(credential[1])
      return
    }
    const provider = path.match(/^\/api\/providers\/([a-f0-9-]{36})(\/models)?$/)
    if (provider) {
      if (!this.settings.providers().some((value) => value.id === provider[1]))
        throw new HttpError(404, "provider_not_found")
      if (provider[2] && req.method === "POST")
        return this.settings.saveModel(provider[1], modelSchema.parse(await input(req)))
      if (!provider[2] && req.method === "PUT")
        return this.settings.saveProvider(providerSchema.parse(await input(req)), provider[1])
      if (!provider[2] && req.method === "DELETE") {
        this.settings.deleteProvider(provider[1])
        return
      }
    }
    const model = path.match(/^\/api\/models\/([a-f0-9-]{36})$/)
    if (model) {
      const existing = this.settings.model(model[1])
      if (!existing) throw new HttpError(404, "model_not_found")
      if (req.method === "PUT")
        return this.settings.saveModel(
          existing.providerId,
          modelSchema.parse(await input(req)),
          existing.id,
        )
      if (req.method === "DELETE") {
        this.settings.deleteModel(existing.id)
        return
      }
    }
    if (path === "/api/selection" && req.method === "PUT") {
      const value = z.strictObject({ modelId: z.uuid().nullable() }).parse(await input(req))
      this.settings.selectModel(value.modelId)
      return
    }
    if (path === "/api/github/private-key") {
      if (req.method === "POST") {
        this.settings.savePrivateKey(await body(req, 32_768, "application/x-pem-file"))
        return
      }
      if (req.method === "DELETE") {
        this.settings.deletePrivateKey()
        return
      }
    }
    if (path === "/api/runtime/reload" && req.method === "POST") return
    throw new HttpError(404, "not_found")
  }
}
