import { TextDecoder } from "node:util"

export const PI_VERSION = "1.5.0"
export const RECORD_LIMIT = 1024 * 1024
export const STREAM_LIMIT = 8 * 1024 * 1024
export const STDERR_LIMIT = 64 * 1024

export function piArguments(model: string, phase: "triage" | "code"): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(model)) throw new Error("invalid_model_id")
  return [
    "/usr/local/bin/node",
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    "--print",
    "--mode",
    "json",
    "--no-session",
    "--no-approve",
    "--no-context-files",
    "--no-extensions",
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--offline",
    "--tools",
    phase === "triage" ? "read,grep,find,ls" : "read,grep,find,ls,bash,edit,write",
    "--provider",
    "reina",
    "--model",
    `reina/${model}`,
    "--thinking",
    "off",
  ]
}

/** Consume LF records, not readline's Unicode line boundaries. Never retain raw streams. */
export class PiStream {
  private pending = Buffer.alloc(0)
  private total = 0
  private stderrBytes = 0
  private records = 0
  private settled = false
  private finalText: string | undefined
  private finalStop: unknown
  private readonly decoder = new TextDecoder("utf-8", { fatal: true })

  stdout(chunk: Buffer): void {
    this.total += chunk.length
    if (this.total > STREAM_LIMIT) throw new Error("pi_stdout_limit")
    let start = 0
    for (;;) {
      const end = chunk.indexOf(10, start)
      if (end < 0) break
      const part = chunk.subarray(start, end)
      if (this.pending.length + part.length > RECORD_LIMIT) throw new Error("pi_record_limit")
      this.record(this.pending.length ? Buffer.concat([this.pending, part]) : part)
      this.pending = Buffer.alloc(0)
      start = end + 1
    }
    const tail = chunk.subarray(start)
    if (this.pending.length + tail.length > RECORD_LIMIT) throw new Error("pi_record_limit")
    if (tail.length) this.pending = Buffer.concat([this.pending, tail])
  }

  stderr(chunk: Buffer): void {
    this.stderrBytes += chunk.length
    if (this.stderrBytes > STDERR_LIMIT) throw new Error("pi_stderr_limit")
  }

  private record(bytes: Buffer): void {
    let data: unknown
    try {
      data = JSON.parse(this.decoder.decode(bytes))
    } catch {
      throw new Error("pi_malformed_json")
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("pi_invalid_event")
    const event = data as Record<string, unknown>
    if (typeof event.type !== "string") throw new Error("pi_invalid_event")
    if (this.records++ === 0 && event.type !== "session") throw new Error("pi_missing_session")
    if (this.settled) throw new Error("pi_event_after_settlement")
    if (event.type === "message_end") {
      const message = event.message as Record<string, unknown> | undefined
      if (!message || typeof message !== "object") throw new Error("pi_invalid_message")
      if (message.role === "assistant") {
        this.finalStop = message.stopReason
        this.finalText = undefined
        if (message.stopReason === "error" || message.stopReason === "aborted")
          throw new Error("pi_agent_error")
        if (!Array.isArray(message.content)) throw new Error("pi_invalid_content")
        const text: string[] = []
        for (const value of message.content) {
          if (!value || typeof value !== "object") throw new Error("pi_invalid_content")
          const block = value as Record<string, unknown>
          if (block.type === "text") {
            if (typeof block.text !== "string") throw new Error("pi_invalid_content")
            text.push(block.text)
          } else if (block.type !== "thinking" && message.stopReason === "stop") {
            throw new Error("pi_unfinished_tool_call")
          }
        }
        this.finalText = text.join("")
      }
    }
    if (event.type === "agent_settled") {
      if (event.aborted !== false) throw new Error("pi_aborted")
      this.settled = true
    }
  }

  finish(exitCode: number): string {
    if (this.pending.length) throw new Error("pi_unterminated_record")
    if (exitCode !== 0) throw new Error("pi_exit_failure")
    if (!this.settled || this.finalStop !== "stop" || !this.finalText?.trim())
      throw new Error("pi_incomplete")
    return this.finalText
  }
}

export function trustedSettings(): Record<string, unknown> {
  return {
    defaultProjectTrust: "never",
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs: 60_000 } },
    enableInstallTelemetry: false,
    enableAnalytics: false,
    packages: [],
  }
}

export function trustedModels(
  model: string,
  capability: string,
  limits: { contextWindow?: number; maxTokens?: number } = {},
): Record<string, unknown> {
  piArguments(model, "triage")
  const contextWindow = limits.contextWindow ?? 128_000
  const maxTokens = limits.maxTokens ?? 4096
  if (
    !Number.isSafeInteger(contextWindow) ||
    contextWindow < 4096 ||
    contextWindow > 4_000_000 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 256 ||
    maxTokens > 4096
  )
    throw new Error("invalid_model_limits")
  if (!/^[a-f0-9]{64}$/.test(capability)) throw new Error("invalid_capability")
  return {
    providers: {
      reina: {
        baseUrl: "http://127.0.0.1:3210/v1",
        api: "openai-completions",
        apiKey: capability,
        authHeader: true,
        models: [
          {
            id: model,
            input: ["text"],
            reasoning: false,
            contextWindow,
            maxTokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            compat: {
              maxTokensField: "max_tokens",
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsUsageInStreaming: true,
              sendSessionAffinityHeaders: false,
            },
          },
        ],
      },
    },
  }
}
