import { randomUUID } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { zstdDecompressSync } from "node:zlib"
import type {
  Api,
  AssistantMessage,
  Context,
  JsonObject,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai"
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages"
import { convertMessages, convertTools } from "@earendil-works/pi-ai/api/google-shared"
import { stream as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses"
import { stream as completionsStream } from "@earendil-works/pi-ai/api/openai-completions"
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import { providerFetch, validateProviderUrl } from "../settings/network.js"
import type { ModelRequest, ModelSelection, SupportedApi } from "../settings/schema.js"
import { retryableStatus, retryableTransport } from "./failure.js"

export type ModelSnapshot = Pick<ModelSelection, "model" | "modelUrl" | "modelKey"> &
  Partial<Omit<ModelSelection, "model" | "modelUrl" | "modelKey">>

const BODY_LIMIT = 1024 * 1024
const RESPONSE_LIMIT = 4 * 1024 * 1024
const FAILURE = "model_gateway_upstream_failed"

type AssistantContent = AssistantMessage["content"]
type ToolCall = Extract<AssistantContent[number], { type: "toolCall" }>

function toolCalls(content: AssistantContent): ToolCall[] {
  return content.filter((part): part is ToolCall => part.type === "toolCall")
}

function visibleText(content: AssistantContent): string {
  return content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

/** Host-only continuation state. Never include this state in worker messages or settings. */
export class AdapterState {
  private readonly entries = new Map<string, { json: string; ids: string[]; bytes: number }>()
  private readonly ids = new Map<string, string>()
  private bytes = 0
  private closed = false

  private remove(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    for (const id of entry.ids) this.ids.delete(id)
    this.entries.delete(key)
    this.bytes -= entry.bytes
  }

  /** Retain native parts, indexed by the emitted public IDs (native ID -> public ID). */
  remember(content: AssistantContent, publicIds?: ReadonlyMap<string, string>): void {
    if (this.closed) return
    const calls = toolCalls(content)
    if (!calls.length || calls.length > 32) return
    const json = JSON.stringify(content)
    const ids = calls.map((call) => publicIds?.get(call.id) ?? call.id)
    const bytes = Buffer.byteLength(json) + Buffer.byteLength(JSON.stringify(ids))
    // A continuation must fit the existing request budget. At most 24 responses
    // can be produced by a gateway; keep the aggregate cache within one body.
    if (bytes > BODY_LIMIT) return
    for (const id of ids) {
      const key = this.ids.get(id)
      if (key) this.remove(key)
    }
    while (this.bytes + bytes > BODY_LIMIT || this.entries.size >= 24) {
      const key = this.entries.keys().next().value
      if (key === undefined) break
      this.remove(key)
    }
    this.entries.set(ids[0], { json, ids, bytes })
    for (const id of ids) this.ids.set(id, ids[0])
    this.bytes += bytes
  }

  restore(content: AssistantContent): AssistantContent {
    const calls = toolCalls(content)
    const key = calls.map((call) => this.ids.get(call.id)).find((key) => key !== undefined)
    if (key === undefined) return content
    const entry = this.entries.get(key)
    if (!entry) throw new Error("invalid_chat_context")
    const original = JSON.parse(entry.json) as AssistantContent
    // A known ID grants no authority to change, split, or combine an assistant
    // turn. Compare parsed arguments so harmless JSON formatting is accepted.
    const expected = toolCalls(original).map(({ name, arguments: args }, index) => ({
      type: "toolCall",
      id: entry.ids[index],
      name,
      arguments: args,
    }))
    if (visibleText(original) !== visibleText(content) || !isDeepStrictEqual(expected, calls))
      throw new Error("invalid_chat_context")
    return original
  }

  /** Permanently close the state so an aborted in-flight stream cannot refill it. */
  clear(): void {
    this.closed = true
    this.entries.clear()
    this.ids.clear()
    this.bytes = 0
  }
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function text(content: unknown): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  if (
    Array.isArray(content) &&
    content.every((part) => part?.type === "text" && typeof part.text === "string")
  )
    return content.map((part) => part.text).join("")
  throw new Error("invalid_chat_context")
}

/** Called only after the gateway validates the OpenAI text/tool allowlist. */
export function toPiContext(
  config: ModelSnapshot,
  data: Record<string, unknown>,
  state?: AdapterState,
): TranscriptContext {
  const context: Context = { messages: [] }
  const calls = new Map<string, { id: string; name: string }>()
  let restoredBytes = 0
  for (const value of data.messages as Record<string, unknown>[]) {
    const content = text(value.content)
    if (calls.size && value.role !== "tool") throw new Error("invalid_chat_context")
    const timestamp = 0
    if (value.role === "system" || value.role === "developer") {
      if (value.tool_calls !== undefined) throw new Error("invalid_chat_context")
      context.messages.push({ role: "system", content, timestamp })
    } else if (value.role === "user") {
      if (value.tool_calls !== undefined) throw new Error("invalid_chat_context")
      context.messages.push({ role: "user", content, timestamp })
    } else if (value.role === "assistant") {
      const parts: AssistantMessage["content"] = content ? [{ type: "text", text: content }] : []
      for (const call of (value.tool_calls ?? []) as {
        id: string
        function: { name: string; arguments: string }
      }[]) {
        const args: unknown = JSON.parse(call.function.arguments)
        if (
          !args ||
          typeof args !== "object" ||
          Array.isArray(args) ||
          !call.id ||
          calls.has(call.id)
        )
          throw new Error("invalid_chat_context")
        calls.set(call.id, { id: call.id, name: call.function.name })
        parts.push({
          type: "toolCall",
          id: call.id,
          name: call.function.name,
          arguments: args as JsonObject,
        })
      }
      const restored = state?.restore(parts) ?? parts
      if (restored !== parts) {
        // Repeated echoes must not expand a small worker request into an
        // unbounded host transcript before the upstream body check.
        restoredBytes += Buffer.byteLength(JSON.stringify(restored))
        if (restoredBytes > BODY_LIMIT) throw new Error("invalid_chat_context")
        const nativeCalls = toolCalls(restored)
        for (const [index, call] of toolCalls(parts).entries()) {
          calls.set(call.id, { id: nativeCalls[index].id, name: nativeCalls[index].name })
        }
      }
      context.messages.push({
        role: "assistant",
        content: restored,
        api: config.modelApi ?? "openai-completions",
        provider: config.modelProvider ?? "configured",
        model: config.model,
        usage: emptyUsage(),
        stopReason: parts.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
        timestamp,
      })
    } else if (value.role === "tool") {
      const id = value.tool_call_id
      if (typeof id !== "string" || !calls.has(id) || value.tool_calls !== undefined)
        throw new Error("invalid_chat_context")
      context.messages.push({
        role: "toolResult",
        toolCallId: calls.get(id)?.id as string,
        toolName: calls.get(id)?.name as string,
        content: [{ type: "text", text: content }],
        isError: false,
        timestamp,
      })
      calls.delete(id)
    } else throw new Error("invalid_chat_context")
  }
  if (calls.size) throw new Error("invalid_chat_context")
  context.tools = (
    (data.tools ?? []) as {
      function: { name: string; description?: string; parameters: object; strict?: boolean }
    }[]
  ).map(({ function: fn }) => ({
    name: fn.name,
    description: fn.description ?? "",
    parameters: fn.parameters,
    ...(fn.strict
      ? { constrainedSampling: { type: "json_schema" as const, strict: "require" as const } }
      : {}),
  }))
  const first = context.messages[0]
  if (first?.role === "system") {
    first.toolsAdded = context.tools
    context.tools = undefined
  }
  return normalizeContext(context)
}

function piModel(config: ModelSnapshot): Model<SupportedApi> {
  const maxTokens = config.maxTokens ?? 4096
  const contextWindow = config.contextWindow ?? 128_000
  if (
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    !Number.isSafeInteger(contextWindow) ||
    contextWindow < 1
  )
    throw new Error(FAILURE)
  return {
    id: config.model,
    name: config.model,
    api: config.modelApi ?? "openai-completions",
    provider: config.modelProvider ?? "configured",
    baseUrl: config.modelUrl,
    input: ["text"],
    reasoning: false,
    contextWindow,
    maxTokens: Math.min(4096, maxTokens),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/** Stop waiting even when a resolver does not implement cancellation correctly. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: () => void = () => {}
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        stop = () => reject(new Error(FAILURE))
        signal.addEventListener("abort", stop, { once: true })
        if (signal.aborted) stop()
      }),
    ])
  } finally {
    signal.removeEventListener("abort", stop)
  }
}

/** Bound both the SDK request and the upstream wire body, including ignored thinking events. */
function limitedFetch(
  fetcher: typeof fetch,
  signal: AbortSignal,
  codex: boolean,
  onRetryableFailure?: () => void,
): typeof fetch {
  return async (input, init) => {
    signal.throwIfAborted()
    // Codex compresses its validated onPayload JSON before calling fetch.
    const body = init?.body
    if (
      !(
        (typeof body === "string" && Buffer.byteLength(body) <= BODY_LIMIT) ||
        (codex &&
          body instanceof Uint8Array &&
          body.byteLength <= BODY_LIMIT &&
          new Headers(init?.headers).get("content-encoding") === "zstd" &&
          zstdDecompressSync(body, { maxOutputLength: BODY_LIMIT }).byteLength <= BODY_LIMIT)
      )
    )
      throw new Error(FAILURE)
    const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal
    let response: Response
    try {
      response = await abortable(
        fetcher(input, { ...init, signal: requestSignal, redirect: "error" }),
        requestSignal,
      )
    } catch (error) {
      if (!requestSignal.aborted && retryableTransport(error)) onRetryableFailure?.()
      throw new Error(FAILURE)
    }
    if (!requestSignal.aborted && retryableStatus(response.status)) onRetryableFailure?.()
    const contentType = response.headers.get("content-type")
    // Codex can omit Content-Type on a successful SSE response. Its SDK still
    // validates stream events; byte, time, origin, and completion checks apply.
    const streamType =
      contentType?.startsWith("text/event-stream") || (codex && contentType === null)
    if (!response.ok || !streamType || !response.body) {
      await response.body?.cancel()
      throw new Error(FAILURE)
    }
    const reader = response.body.getReader()
    let bytes = 0
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted()
            const next = await abortable(reader.read(), requestSignal)
            if (next.done) return controller.close()
            bytes += next.value.byteLength
            if (bytes > RESPONSE_LIMIT) throw new Error(FAILURE)
            controller.enqueue(next.value)
          } catch (error) {
            if (!requestSignal.aborted && retryableTransport(error)) onRetryableFailure?.()
            await reader.cancel().catch(() => {})
            controller.error(new Error(FAILURE))
          }
        },
        cancel: () => reader.cancel(),
      }),
      { status: response.status, headers: response.headers },
    )
  }
}

// pi-ai 1.5.0's Google SDK adapter rejects custom fetch. Use its message/tool
// converters with the REST SSE endpoint so public-DNS checks cannot be bypassed.
async function* googleChunks(
  model: Model<"google-generative-ai">,
  context: TranscriptContext,
  data: Record<string, unknown>,
  auth: ModelRequest["auth"],
  signal: AbortSignal,
  fetcher: typeof fetch,
): AsyncGenerator<{
  text?: string
  call?: { id: string; name: string; arguments: string }
  finish?: string
  content?: AssistantContent
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
}> {
  const tools = context.messages.flatMap((message) =>
    message.role === "system" ? (message.toolsAdded ?? []) : [],
  )
  const system = context.messages
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n\n")
  const choice = data.tool_choice
  const selected =
    typeof choice === "object" && choice !== null
      ? (choice as { function: { name: string } }).function.name
      : undefined
  const body = {
    contents: convertMessages(model, context),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      maxOutputTokens: model.maxTokens,
      ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
      ...(data.top_p !== undefined ? { topP: data.top_p } : {}),
    },
    ...(tools.length
      ? {
          tools: convertTools(tools),
          toolConfig: {
            functionCallingConfig: {
              mode: choice === "none" ? "NONE" : choice === "required" || selected ? "ANY" : "AUTO",
              ...(selected ? { allowedFunctionNames: [selected] } : {}),
            },
          },
        }
      : {}),
  }
  const url = `${model.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(model.id.replace(/^models\//, ""))}:streamGenerateContent?alt=sse`
  const headers = new Headers({ "content-type": "application/json" })
  if (auth.apiKey) headers.set("x-goog-api-key", auth.apiKey)
  for (const source of [model.headers, auth.headers]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value === null) headers.delete(name)
      else headers.set(name, value)
    }
  }
  const response = await fetcher(url, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify(body),
  })
  if (!response.body) throw new Error(FAILURE)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let finish = "stop"
  let finished = false
  let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined
  let hasCalls = false
  const content: AssistantContent = []
  let contentBytes = 0
  const append = (part: AssistantContent[number]) => {
    contentBytes += Buffer.byteLength(JSON.stringify(part))
    if (contentBytes > RESPONSE_LIMIT) throw new Error(FAILURE)
    content.push(part)
  }
  try {
    while (true) {
      signal.throwIfAborted()
      const next = await reader.read()
      pending += decoder.decode(next.value, { stream: !next.done }).replace(/\r/g, "")
      let end = pending.indexOf("\n\n")
      while (end !== -1) {
        const frame = pending.slice(0, end)
        pending = pending.slice(end + 2)
        const payload = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (payload) {
          const chunk = JSON.parse(payload)
          if (chunk.error) throw new Error(FAILURE)
          const candidate = chunk.candidates?.[0]
          for (const part of candidate?.content?.parts ?? []) {
            const signature =
              typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined
            // Keep each signed part separate. A signature is not a thinking marker.
            // pi-ai/google-shared maps these three signature fields back to parts.
            // https://ai.google.dev/gemini-api/docs/thought-signatures
            if (typeof part.text === "string" || (!part.functionCall && signature)) {
              const value = part.text ?? ""
              append(
                part.thought === true
                  ? { type: "thinking", thinking: value, thinkingSignature: signature }
                  : { type: "text", text: value, textSignature: signature },
              )
              if (part.thought !== true) yield { text: value }
            }
            if (part.functionCall) {
              const args = part.functionCall.args ?? {}
              if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(FAILURE)
              hasCalls = true
              const call: ToolCall = {
                type: "toolCall",
                id: `call_${randomUUID()}`,
                name: part.functionCall.name,
                arguments: args,
                thoughtSignature: signature,
              }
              append(call)
              yield {
                call: { id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) },
              }
            }
          }
          if (candidate?.finishReason) {
            finished = true
            if (!["STOP", "MAX_TOKENS"].includes(candidate.finishReason)) throw new Error(FAILURE)
            finish = candidate.finishReason === "MAX_TOKENS" ? "length" : "stop"
          }
          if (chunk.usageMetadata) {
            const info = chunk.usageMetadata
            usage = {
              prompt_tokens: info.promptTokenCount ?? 0,
              completion_tokens: (info.candidatesTokenCount ?? 0) + (info.thoughtsTokenCount ?? 0),
              total_tokens: info.totalTokenCount ?? 0,
            }
          }
        }
        end = pending.indexOf("\n\n")
      }
      if (next.done) break
    }
    if (pending.trim() || !finished) throw new Error(FAILURE)
    yield { finish: hasCalls && finish !== "length" ? "tool_calls" : finish, usage, content }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Emit OpenAI chat-completion SSE. Endpoint, credentials, and API come only from the snapshot. */
export async function* piChatStream(
  config: ModelSnapshot,
  data: Record<string, unknown>,
  signal: AbortSignal,
  fetcher?: typeof fetch,
  state?: AdapterState,
  onRetryableFailure?: () => void,
): AsyncGenerator<string> {
  const callerSignal = signal
  const timeout = AbortSignal.timeout(60_000)
  try {
    signal = AbortSignal.any([callerSignal, timeout])
    signal.throwIfAborted()
    // Validate history before resolving credentials (which can refresh over the network).
    const context = toPiContext(config, data, state)
    const limits = piModel(config)
    const resolved = config.resolveModelRequest
      ? await abortable(config.resolveModelRequest(signal), signal)
      : undefined
    signal.throwIfAborted()
    if (config.resolveModelRequest && !resolved) throw new Error(FAILURE)
    if (resolved) {
      if (
        resolved.model.id !== config.model ||
        resolved.model.api !== limits.api ||
        resolved.model.provider !== limits.provider ||
        resolved.model.baseUrl !== (resolved.auth.baseUrl ?? config.modelUrl)
      )
        throw new Error(FAILURE)
      validateProviderUrl(resolved.model.baseUrl)
    }
    const auth = resolved?.auth ?? { apiKey: config.modelKey }
    if (!auth.apiKey && !Object.values(auth.headers ?? {}).some((value) => !!value))
      throw new Error(FAILURE)
    const model: Model<Api> = resolved
      ? {
          ...resolved.model,
          maxTokens: Math.min(limits.maxTokens, resolved.model.maxTokens),
        }
      : limits
    if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) throw new Error(FAILURE)
    const safeFetch = limitedFetch(
      fetcher ?? providerFetch(model.baseUrl),
      signal,
      model.api === "openai-codex-responses",
      onRetryableFailure,
    )
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    let bytes = 0
    let toolIndex = 0
    let completed = false
    let continuation: AssistantContent | undefined
    const callIds = new Set<string>()
    const publicIds = new Map<string, string>()
    const names = new Set(
      ((data.tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name),
    )
    const frame = (delta: object, finish: string | null = null, usage?: object) => {
      const value = `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: config.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
      bytes += Buffer.byteLength(value)
      if (bytes > RESPONSE_LIMIT) throw new Error(FAILURE)
      return value
    }
    const toolFrame = (call: { id: string; name: string; arguments: string }, opaque = false) => {
      if (!names.has(call.name) || toolIndex >= 32 || callIds.has(call.id)) throw new Error(FAILURE)
      callIds.add(call.id)
      // The worker's Completions converter rewrites pipe-separated Responses IDs.
      // Keep native IDs host-only and use a short, normalizer-safe public ID.
      const publicId = opaque ? `call_${randomUUID().replaceAll("-", "")}` : call.id
      publicIds.set(call.id, publicId)
      return frame({
        tool_calls: [
          {
            index: toolIndex++,
            id: publicId,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          },
        ],
      })
    }
    const includeUsage = (data.stream_options as { include_usage?: boolean } | undefined)
      ?.include_usage
    if (model.api === "google-generative-ai") {
      let started = false
      for await (const chunk of googleChunks(
        model as Model<"google-generative-ai">,
        context,
        data,
        auth,
        signal,
        safeFetch,
      )) {
        if (!started) {
          started = true
          yield frame({ role: "assistant", content: "" })
        }
        if (chunk.text !== undefined) yield frame({ content: chunk.text })
        if (chunk.call) yield toolFrame(chunk.call)
        if (chunk.finish) {
          completed = true
          continuation = chunk.content
          yield frame({}, chunk.finish, includeUsage ? chunk.usage : undefined)
        }
      }
    } else {
      const choice = data.tool_choice as
        | "auto"
        | "none"
        | "required"
        | { type: "function"; function: { name: string } }
        | undefined
      const options = {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: resolved?.env ?? {},
        fetch: safeFetch,
        signal,
        maxTokens: model.maxTokens,
        maxRetries: 0,
        timeoutMs: 60_000,
        cacheRetention: "none" as const,
        transport: "sse" as const,
        onPayload: (payload: unknown) => {
          if (!payload || typeof payload !== "object" || Array.isArray(payload))
            throw new Error(FAILURE)
          const body = payload as Record<string, unknown>
          body.model = model.id
          body.stream = true
          if ("store" in body) body.store = false
          for (const field of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
            if (body[field] !== undefined) body[field] = model.maxTokens
          }
          // Codex has no SDK-supported output-token field. Keep its native payload;
          // request, time, and response-byte limits still apply.
          if (model.api === "openai-codex-responses" && typeof choice === "object")
            body.tool_choice = { type: "function", name: choice.function.name }
          if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT) throw new Error(FAILURE)
          return body
        },
        ...(data.top_p !== undefined ? { samplingParams: { top_p: data.top_p } } : {}),
        ...(data.temperature !== undefined ? { temperature: data.temperature as number } : {}),
      }
      const events =
        model.api === "anthropic-messages"
          ? anthropicStream(model as Model<"anthropic-messages">, context, {
              ...options,
              toolChoice:
                choice === "required"
                  ? "any"
                  : typeof choice === "object"
                    ? { type: "tool", name: choice.function.name }
                    : choice,
            })
          : model.api === "openai-completions"
            ? completionsStream(model as Model<"openai-completions">, context, {
                ...options,
                toolChoice: choice,
              })
            : model.api === "openai-responses"
              ? responsesStream(model as Model<"openai-responses">, context, {
                  ...options,
                  toolChoice:
                    typeof choice === "object"
                      ? { type: "function", name: choice.function.name }
                      : choice,
                })
              : model.api === "openai-codex-responses"
                ? codexStream(model as Model<"openai-codex-responses">, context, {
                    ...options,
                    toolChoice: typeof choice === "object" ? "required" : choice,
                  })
                : (() => {
                    throw new Error(FAILURE)
                  })()
      for await (const event of events) {
        signal.throwIfAborted()
        if (event.type === "error") throw new Error(FAILURE)
        if (event.type === "start") yield frame({ role: "assistant", content: "" })
        if (event.type === "text_delta") yield frame({ content: event.delta })
        if (event.type === "toolcall_end") {
          if (event.toolCall.argumentsError) throw new Error(FAILURE)
          yield toolFrame(
            {
              id: event.toolCall.id,
              name: event.toolCall.name,
              arguments: JSON.stringify(event.toolCall.arguments),
            },
            true,
          )
        }
        if (event.type === "done") {
          if (event.reason === "deferred") throw new Error(FAILURE)
          completed = true
          continuation = event.message.content
          const usage = event.message.usage
          yield frame(
            {},
            event.reason === "toolUse" ? "tool_calls" : event.reason,
            includeUsage
              ? {
                  prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
                  completion_tokens: usage.output,
                  total_tokens: usage.totalTokens,
                }
              : undefined,
          )
        }
      }
    }
    signal.throwIfAborted()
    if (!completed) throw new Error(FAILURE)
    if (continuation) state?.remember(continuation, publicIds)
    yield "data: [DONE]\n\n"
  } catch {
    if (timeout.aborted && !callerSignal.aborted) onRetryableFailure?.()
    throw new Error(FAILURE)
  }
}
