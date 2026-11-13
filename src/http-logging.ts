import type { IncomingMessage } from "node:http"
import type { Logger } from "./types.js"

const methods = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])
const routes = new Set([
  "/",
  "/healthz",
  "/login",
  "/auth/login",
  "/auth/callback",
  "/auth/logout",
  "/assets/style.css",
  "/assets/app.js",
  "/api/github/webhooks",
  "/api/settings",
  "/api/catalog",
  "/api/providers",
  "/api/provider-setups",
  "/api/selection",
  "/api/github/private-key",
  "/api/runtime/reload",
])
const routeTemplates = [
  [/^\/api\/providers\/[a-f0-9-]{36}$/, "/api/providers/:id"],
  [/^\/api\/providers\/[a-f0-9-]{36}\/models$/, "/api/providers/:id/models"],
  [/^\/api\/providers\/[a-f0-9-]{36}\/credential$/, "/api/providers/:id/credential"],
  [/^\/api\/models\/[a-f0-9-]{36}$/, "/api/models/:id"],
  [/^\/api\/provider-setups\/[a-f0-9-]{36}$/, "/api/provider-setups/:id"],
  [/^\/api\/provider-setups\/[a-f0-9-]{36}\/responses$/, "/api/provider-setups/:id/responses"],
] as const

type FailureReason = "settings_unavailable" | "request_handler_failed" | "webhook_intake_failed"

// Only fixed route names and methods can enter logs. Never include request or error objects.
export function logHttpFailure(
  log: Logger,
  req: Pick<IncomingMessage, "method" | "url">,
  reason: FailureReason,
  status: number,
): void {
  const path = req.url?.split("?", 1)[0] ?? ""
  const route = routes.has(path)
    ? path
    : (routeTemplates.find(([pattern]) => pattern.test(path))?.[1] ?? "unknown")
  log.error({
    event: "http_request_failed",
    reason,
    method: req.method && methods.has(req.method) ? req.method : "unknown",
    route,
    status,
  })
}
