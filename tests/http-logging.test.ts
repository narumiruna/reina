import { describe, expect, it, vi } from "vitest"
import { logHttpFailure } from "../src/http-logging.js"

const id = "12345678-1234-1234-1234-123456789abc"

describe("HTTP failure log metadata", () => {
  it.each([
    ["/", "/"],
    ["/api/settings", "/api/settings"],
    ["/api/runtime/settings", "/api/runtime/settings"],
    ["/api/github/app", "/api/github/app"],
    ["/api/github/connect", "/api/github/connect"],
    ["/api/github/connect/install", "/api/github/connect/install"],
    ["/api/github/connect/refresh", "/api/github/connect/refresh"],
    ["/api/github/connect/select", "/api/github/connect/select"],
    ["/api/github/connect/cancel", "/api/github/connect/cancel"],
    ["/auth/github/callback?code=private-code&state=private-state", "/auth/github/callback"],
    ["/auth/github/setup?installation_id=123&state=private-state", "/auth/github/setup"],
    ["/auth/callback?code=private-code&state=private-state", "/auth/callback"],
    [`/api/providers/${id}`, "/api/providers/:id"],
    [`/api/providers/${id}/models`, "/api/providers/:id/models"],
    [`/api/providers/${id}/credential`, "/api/providers/:id/credential"],
    [`/api/models/${id}`, "/api/models/:id"],
    [`/api/provider-setups/${id}`, "/api/provider-setups/:id"],
    [`/api/provider-setups/${id}/responses`, "/api/provider-setups/:id/responses"],
    ["/private-path?token=private-query", "unknown"],
    ["/api/providers/private-id", "unknown"],
    ["//private-host/api/settings", "unknown"],
    ["https://private-host/api/settings", "unknown"],
    ["/api/settings/private-suffix", "unknown"],
    [undefined, "unknown"],
  ])("uses only allowlisted route metadata for %s", (url, route) => {
    const log = { info: vi.fn(), error: vi.fn() }
    logHttpFailure(log, { url, method: "GET" }, "request_handler_failed", 503)
    expect(log.error).toHaveBeenCalledExactlyOnceWith({
      event: "http_request_failed",
      reason: "request_handler_failed",
      method: "GET",
      route,
      status: 503,
    })
    const logs = JSON.stringify(log.error.mock.calls)
    expect(logs).not.toContain("private-")
    expect(logs).not.toContain(id)
  })

  it.each([
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "HEAD",
    "OPTIONS",
    "PRIVATE-METHOD",
    "get",
    undefined,
  ])("uses only allowlisted method metadata for %s", (method) => {
    const log = { info: vi.fn(), error: vi.fn() }
    logHttpFailure(log, { url: "/api/providers", method }, "settings_unavailable", 500)
    expect(log.error).toHaveBeenCalledExactlyOnceWith({
      event: "http_request_failed",
      reason: "settings_unavailable",
      method:
        method === "PRIVATE-METHOD" || method === "get" || method === undefined
          ? "unknown"
          : method,
      route: "/api/providers",
      status: 500,
    })
  })
})
