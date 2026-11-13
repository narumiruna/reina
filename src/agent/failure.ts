const TRANSPORT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
])

/** Use only with a response received from the trusted upstream transport. */
export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/** Inspect transport error codes, not provider text or SDK error messages. */
export function retryableTransport(error: unknown): boolean {
  const seen = new Set<object>()
  for (let depth = 0; depth < 8; depth++) {
    if (!error || typeof error !== "object" || seen.has(error)) return false
    seen.add(error)
    const value = error as { code?: unknown; cause?: unknown }
    if (typeof value.code === "string" && TRANSPORT_CODES.has(value.code)) return true
    error = value.cause
  }
  return false
}
