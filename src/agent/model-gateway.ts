import { randomBytes, timingSafeEqual } from "node:crypto"
import { chmod, unlink } from "node:fs/promises"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import type { Config } from "../types.js"

const BODY_LIMIT = 1024 * 1024
const RESPONSE_LIMIT = 4 * 1024 * 1024
const BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"])
const ALLOWED_FIELDS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "parallel_tool_calls",
  "store",
])

export interface GatewayOptions {
  requests: number
  lifetimeMs: number
}

/** One socket, one expiring capability, one upstream URL and model. This is not a proxy. */
export class ModelGateway {
  readonly capability = randomBytes(32).toString("hex")
  private readonly server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void this.handle(req, res)
  })
  private readonly active = new Set<http.ClientRequest>()
  private readonly expiresAt: number
  private readonly endpoint: URL
  private remaining: number
  private revoked = false
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly config: Pick<Config, "modelUrl" | "modelKey" | "model">,
    readonly socketPath: string,
    options: GatewayOptions,
  ) {
    this.endpoint = new URL(`${config.modelUrl.replace(/\/$/, "")}/chat/completions`)
    if (
      !["https:", "http:"].includes(this.endpoint.protocol) ||
      this.endpoint.username ||
      this.endpoint.password ||
      this.endpoint.search ||
      this.endpoint.hash
    )
      throw new Error("invalid_model_endpoint")
    if (
      !Number.isSafeInteger(options.requests) ||
      options.requests < 1 ||
      options.requests > 24 ||
      options.lifetimeMs < 1 ||
      options.lifetimeMs > 600_000
    )
      throw new Error("invalid_gateway_budget")
    this.remaining = options.requests
    this.expiresAt = Date.now() + options.lifetimeMs
    this.server.maxConnections = 8
    this.server.maxHeadersCount = 32
    this.server.headersTimeout = 10_000
    this.server.requestTimeout = 30_000
    this.server.keepAliveTimeout = 1000
    this.server.on("connect", (_req, socket) => {
      socket.destroy()
    })
    this.server.on("upgrade", (_req, socket) => {
      socket.destroy()
    })
    this.server.on("clientError", (_error, socket) => {
      socket.destroy()
    })
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject)
      this.server.listen(this.socketPath, () => {
        this.server.off("error", reject)
        resolve()
      })
    })
    // The containing host directory is 0700. Docker receives only the socket inode.
    await chmod(this.socketPath, 0o666)
    this.timer = setTimeout(
      () => {
        this.revoke()
      },
      Math.max(1, this.expiresAt - Date.now()),
    )
    this.timer.unref()
  }

  private deny(res: ServerResponse, status: number): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.writeHead(status, { "content-type": "application/json", connection: "close" })
    res.end('{"error":{"message":"model_gateway_denied","type":"gateway_error"}}')
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      req.on("error", () => {
        res.destroy()
      })
      req.setTimeout(30_000, () => {
        req.destroy()
      })
      const auth = req.headers.authorization ?? ""
      const expected = `Bearer ${this.capability}`
      if (
        this.revoked ||
        Date.now() >= this.expiresAt ||
        Buffer.byteLength(auth) !== expected.length ||
        !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
      ) {
        this.deny(res, 401)
        req.resume()
        return
      }
      if (
        req.method !== "POST" ||
        req.url !== "/v1/chat/completions" ||
        req.headers["content-encoding"] ||
        Object.keys(req.headers).some((key) =>
          /^(forwarded$|x-forwarded-|proxy-|x-original-url$|x-rewrite-url$)/.test(key),
        )
      ) {
        this.deny(res, 403)
        req.resume()
        return
      }
      if (this.remaining-- <= 0) {
        this.deny(res, 429)
        req.resume()
        return
      }
      if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
        this.deny(res, 400)
        req.resume()
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > BODY_LIMIT) {
          this.deny(res, 413)
          req.destroy()
          return
        }
        chunks.push(Buffer.from(chunk))
      }
      if (this.revoked || Date.now() >= this.expiresAt) {
        this.deny(res, 401)
        return
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        this.deny(res, 400)
        return
      }
      const data = body as Record<string, unknown>
      if (
        Object.keys(data).some((key) => !ALLOWED_FIELDS.has(key)) ||
        data.model !== this.config.model ||
        data.stream !== true ||
        !Array.isArray(data.messages) ||
        data.messages.length > 512 ||
        !this.textMessages(data.messages) ||
        !this.functionTools(data.tools, data.tool_choice) ||
        (data.stream_options !== undefined &&
          (!data.stream_options ||
            typeof data.stream_options !== "object" ||
            Array.isArray(data.stream_options) ||
            Object.keys(data.stream_options).some((key) => key !== "include_usage") ||
            typeof (data.stream_options as Record<string, unknown>).include_usage !== "boolean"))
      ) {
        this.deny(res, 400)
        return
      }
      // Never forward URL/routing fields or request headers. The endpoint must support max_tokens.
      const output = {
        ...data,
        model: this.config.model,
        max_tokens: 4096,
        n: 1,
        store: false,
        stream: true,
      }
      delete (output as Record<string, unknown>).max_completion_tokens
      const payload = JSON.stringify(output)
      if (Buffer.byteLength(payload) > BODY_LIMIT) {
        this.deny(res, 413)
        return
      }
      const upstream = (this.endpoint.protocol === "https:" ? https : http).request(this.endpoint, {
        method: "POST",
        timeout: Math.min(60_000, this.expiresAt - Date.now()),
        headers: {
          authorization: `Bearer ${this.config.modelKey}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          accept: "text/event-stream",
        },
      })
      this.active.add(upstream)
      const stop = () => {
        upstream.destroy()
        this.active.delete(upstream)
      }
      res.once("close", stop)
      upstream.once("timeout", () => {
        upstream.destroy()
      })
      upstream.once("error", () => {
        this.active.delete(upstream)
        this.deny(res, 502)
      })
      upstream.once("response", (response) => {
        if (
          response.statusCode !== 200 ||
          !response.headers["content-type"]?.startsWith("text/event-stream")
        ) {
          response.resume()
          stop()
          this.deny(res, 502)
          return
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" })
        let bytes = 0
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length
          if (this.revoked || Date.now() >= this.expiresAt || bytes > RESPONSE_LIMIT) {
            stop()
            res.destroy()
            return
          }
          if (!res.write(chunk)) response.pause()
        })
        res.on("drain", () => {
          response.resume()
        })
        response.once("error", () => {
          stop()
          res.destroy()
        })
        response.once("end", () => {
          this.active.delete(upstream)
          res.end()
        })
      })
      upstream.end(payload)
    } catch {
      this.deny(res, 400)
    }
  }

  private functionTools(tools: unknown, choice: unknown): boolean {
    const names = new Set<string>()
    if (tools !== undefined) {
      if (!Array.isArray(tools) || tools.length > 7) return false
      for (const tool of tools) {
        if (
          !tool ||
          typeof tool !== "object" ||
          Array.isArray(tool) ||
          tool.type !== "function" ||
          Object.keys(tool).some((key) => !["type", "function"].includes(key))
        )
          return false
        const fn = tool.function
        if (
          !fn ||
          typeof fn !== "object" ||
          Array.isArray(fn) ||
          !BUILTIN_TOOLS.has(fn.name) ||
          names.has(fn.name) ||
          Object.keys(fn).some(
            (key) => !["name", "description", "parameters", "strict"].includes(key),
          )
        )
          return false
        if (
          (fn.description !== undefined &&
            (typeof fn.description !== "string" || fn.description.length > 8192)) ||
          (fn.strict !== undefined && typeof fn.strict !== "boolean") ||
          !fn.parameters ||
          typeof fn.parameters !== "object" ||
          Array.isArray(fn.parameters)
        )
          return false
        // External schema references are not required by Pi's built-in tools.
        const schemas = [fn.parameters]
        while (schemas.length) {
          const schema = schemas.pop()
          for (const [key, value] of Object.entries(schema)) {
            if (["$ref", "$id", "$schema"].includes(key)) return false
            if (value && typeof value === "object") {
              if (Array.isArray(value))
                schemas.push(...value.filter((item) => item && typeof item === "object"))
              else schemas.push(value)
            }
          }
        }
        names.add(fn.name)
      }
    }
    if (choice === undefined || choice === "auto" || choice === "none" || choice === "required")
      return true
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) return false
    const selected = choice as Record<string, unknown>
    const fn = selected.function as Record<string, unknown> | undefined
    return (
      selected.type === "function" &&
      Object.keys(selected).every((key) => ["type", "function"].includes(key)) &&
      !!fn &&
      typeof fn === "object" &&
      !Array.isArray(fn) &&
      Object.keys(fn).length === 1 &&
      typeof fn.name === "string" &&
      names.has(fn.name)
    )
  }

  private textMessages(messages: unknown[]): boolean {
    return messages.every((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return false
      const value = message as Record<string, unknown>
      if (!new Set(["system", "developer", "user", "assistant", "tool"]).has(String(value.role)))
        return false
      if (
        Object.keys(value).some(
          (key) => !["role", "content", "tool_calls", "tool_call_id", "name"].includes(key),
        )
      )
        return false
      if (
        value.tool_calls !== undefined &&
        (!Array.isArray(value.tool_calls) ||
          value.tool_calls.length > 32 ||
          !value.tool_calls.every(
            (call) =>
              call &&
              typeof call === "object" &&
              call.type === "function" &&
              typeof call.id === "string" &&
              Object.keys(call).every((key) => ["id", "type", "function"].includes(key)) &&
              call.function &&
              typeof call.function === "object" &&
              Object.keys(call.function).every((key) => ["name", "arguments"].includes(key)) &&
              BUILTIN_TOOLS.has(call.function.name) &&
              typeof call.function.arguments === "string",
          ))
      )
        return false
      return (
        value.content === null ||
        typeof value.content === "string" ||
        (Array.isArray(value.content) &&
          value.content.every(
            (part) =>
              part &&
              typeof part === "object" &&
              part.type === "text" &&
              typeof part.text === "string" &&
              Object.keys(part).every((key) => ["type", "text"].includes(key)),
          ))
      )
    })
  }

  revoke(): void {
    this.revoked = true
    clearTimeout(this.timer)
    for (const request of this.active) request.destroy()
    this.active.clear()
    this.server.closeAllConnections()
  }

  async close(): Promise<void> {
    this.revoke()
    if (this.server.listening)
      await new Promise<void>((resolve) => {
        this.server.close(() => resolve())
      })
    await unlink(this.socketPath).catch(() => {})
  }
}
