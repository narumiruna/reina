import { mkdtemp, rm } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { zstdDecompressSync } from "node:zlib"
import type { Api, Model, OAuthCredential } from "@earendil-works/pi-ai"
import { convertMessages as convertWorkerMessages } from "@earendil-works/pi-ai/api/openai-completions"
import { builtinProviders } from "@earendil-works/pi-ai/providers/all"
import { describe, expect, it, vi } from "vitest"
import { ModelGateway } from "../src/agent/model-gateway.js"
import {
  AdapterState,
  type ModelSnapshot,
  piChatStream,
  toPiContext,
} from "../src/agent/pi-adapter.js"
import { modelCatalog } from "../src/settings/catalog.js"
import * as providerNetwork from "../src/settings/network.js"
import { getBuiltinModel, getBuiltinProvider } from "../src/settings/providers.js"
import { type ModelRequest, type SupportedApi, supportedApis } from "../src/settings/schema.js"

const snapshot: ModelSnapshot = {
  model: "fixture-model",
  modelUrl: "https://provider.example/v1",
  modelKey: "fixture-secret",
  modelApi: "openai-responses",
  modelProvider: "fixture",
  contextWindow: 128_000,
  maxTokens: 2048,
}
const tools = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
]
const request = {
  model: snapshot.model,
  stream: true,
  messages: [{ role: "user", content: "Hello" }],
  tools,
}

function sse(events: unknown[]): Response {
  return new Response(
    events
      .map(
        (event) =>
          `${(event as { type?: string }).type ? `event: ${(event as { type: string }).type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  )
}

async function collect(
  config: ModelSnapshot,
  data: Record<string, unknown>,
  fetcher?: typeof fetch,
  signal = new AbortController().signal,
  state?: AdapterState,
): Promise<string> {
  let output = ""
  for await (const chunk of piChatStream(config, data, signal, fetcher, state)) output += chunk
  return output
}

interface ChatFrame {
  choices: {
    delta: {
      content?: string
      tool_calls?: {
        id: string
        index: number
        type: string
        function: { name: string; arguments: string }
      }[]
    }
    finish_reason: string | null
  }[]
  usage?: { prompt_tokens: number; completion_tokens: number }
}

function frames(output: string): ChatFrame[] {
  return output
    .split("\n\n")
    .filter((line) => line && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)))
}

// Use the worker's actual Completions converter, including its pipe-ID normalizer.
function workerMessages(data: Record<string, unknown>, source?: ModelSnapshot) {
  const config: ModelSnapshot = {
    ...snapshot,
    modelApi: "openai-completions",
    modelProvider: "reina",
  }
  const model: Model<"openai-completions"> = {
    id: config.model,
    name: config.model,
    api: "openai-completions",
    provider: "reina",
    baseUrl: "http://worker.invalid/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  // This fixture needs no compatibility switches. Undefined switches are false.
  return convertWorkerMessages(
    model,
    toPiContext(source ?? config, data),
    {} as Parameters<typeof convertWorkerMessages>[2],
  )
}

function workerTurn(output: string, source?: ModelSnapshot) {
  const parsed = frames(output)
  const assistant = {
    role: "assistant",
    content: parsed.map((frame) => frame.choices[0].delta.content ?? "").join(""),
    tool_calls: parsed
      .flatMap((frame) => frame.choices[0].delta.tool_calls ?? [])
      .map(({ index: _index, ...call }) => call),
  }
  return {
    ...request,
    messages: workerMessages(
      {
        messages: [
          ...request.messages,
          assistant,
          { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "File text" },
        ],
      },
      source,
    ),
  }
}

function responsesEvents(tool = false): unknown[] {
  const item = tool
    ? { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" }
    : { type: "message", id: "msg_1", role: "assistant", content: [] }
  return [
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item },
    tool
      ? {
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: '{"path":"README.md"}',
        }
      : { type: "response.output_text.delta", output_index: 0, delta: "Hello back" },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: tool
        ? { ...item, arguments: '{"path":"README.md"}' }
        : { ...item, content: [{ type: "output_text", text: "Hello back" }] },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      },
    },
  ]
}

function sendGateway(gateway: ModelGateway, body: object) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: gateway.socketPath,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: `Bearer ${gateway.capability}`,
          "content-type": "application/json",
        },
      },
      (res) => {
        let value = ""
        res.on("data", (chunk) => {
          value += chunk
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: value }))
        res.on("error", reject)
      },
    )
    req.on("error", reject)
    req.end(JSON.stringify(body))
  })
}

describe("pi-ai chat adapter", () => {
  it("converts text, developer instructions, tools, and tool results", () => {
    const context = toPiContext(snapshot, {
      tools,
      messages: [
        { role: "developer", content: [{ type: "text", text: "Be concise" }] },
        { role: "user", content: "Read" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read", arguments: '{"path":"README.md"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "File text" },
      ],
    })
    expect(context.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
    ])
    expect(context.messages[0]).toMatchObject({
      content: "Be concise",
      toolsAdded: [{ name: "read" }],
    })
    expect(context.messages[2]).toMatchObject({
      content: [{ type: "toolCall", arguments: { path: "README.md" } }],
    })
    expect(context.messages[3]).toMatchObject({
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "File text" }],
    })
  })

  it("rejects orphan tool results and non-object tool arguments", () => {
    expect(() =>
      toPiContext(snapshot, {
        messages: [{ role: "tool", tool_call_id: "missing", content: "x" }],
      }),
    ).toThrow("invalid_chat_context")
    expect(() =>
      toPiContext(snapshot, {
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "c", function: { name: "read", arguments: "[]" } }],
          },
        ],
      }),
    ).toThrow("invalid_chat_context")
  })

  it("streams Responses text with a fixed URL, key, model, and output cap", async () => {
    const fetcher = vi.fn(async (_input, _init) =>
      sse(responsesEvents()),
    ) as unknown as typeof fetch
    const output = await collect(
      { ...snapshot, maxTokens: 9000 },
      { ...request, max_tokens: 999999, stream_options: { include_usage: true } },
      fetcher,
    )
    expect(output).toContain("Hello back")
    expect(output).toContain("data: [DONE]")
    const [url, init] = vi.mocked(fetcher).mock.calls[0]
    expect(String(url)).toBe("https://provider.example/v1/responses")
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-secret")
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: snapshot.model,
      max_output_tokens: 4096,
      store: false,
      stream: true,
    })
    expect(init?.redirect).toBe("error")
    expect(frames(output).at(-1)).toMatchObject({
      choices: [{ finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    })
  })

  it("normalizes Responses tool calls and forced tool selection", async () => {
    const fetcher = vi.fn(async () => sse(responsesEvents(true))) as unknown as typeof fetch
    const output = await collect(
      snapshot,
      { ...request, tool_choice: { type: "function", function: { name: "read" } } },
      fetcher,
    )
    expect(
      frames(output).find((frame) => frame.choices[0].delta.tool_calls)?.choices[0].delta
        .tool_calls?.[0],
    ).toMatchObject({
      index: 0,
      type: "function",
      function: { name: "read", arguments: '{"path":"README.md"}' },
    })
    expect(frames(output).at(-1)?.choices[0].finish_reason).toBe("tool_calls")
    expect(JSON.parse(vi.mocked(fetcher).mock.calls[0][1]?.body as string).tool_choice).toEqual({
      type: "function",
      name: "read",
    })
  })

  it("streams Anthropic text and tool calls using the saved API", async () => {
    const fetcher = vi.fn(async () =>
      sse([
        {
          type: "message_start",
          message: {
            id: "msg",
            role: "assistant",
            content: [],
            usage: { input_tokens: 2, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Anthropic text" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "call_a", name: "read", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' },
        },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
        { type: "message_stop" },
      ]),
    ) as unknown as typeof fetch
    const output = await collect(
      { ...snapshot, modelApi: "anthropic-messages", modelUrl: "https://provider.example" },
      { ...request, tool_choice: "required" },
      fetcher,
    )
    expect(output).toContain("Anthropic text")
    expect(output).toContain('\\"path\\":\\"README.md\\"')
    expect(frames(output).at(-1)?.choices[0].finish_reason).toBe("tool_calls")
    const [url, init] = vi.mocked(fetcher).mock.calls[0]
    expect(String(url)).toBe("https://provider.example/v1/messages?beta=true")
    expect(new Headers(init?.headers).get("x-api-key")).toBe(snapshot.modelKey)
    expect(JSON.parse(init?.body as string)).toMatchObject({
      max_tokens: 2048,
      tool_choice: { type: "any" },
    })
  })

  it("uses pi-ai Google converters with safe fetch and normalizes text/tools", async () => {
    const fetcher = vi.fn(async () =>
      sse([
        {
          candidates: [
            {
              content: {
                parts: [{ text: "Google text" }, { text: "private reasoning", thought: true }],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: "read", args: { path: "README.md" } } }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
        },
      ]),
    ) as unknown as typeof fetch
    const output = await collect(
      { ...snapshot, modelApi: "google-generative-ai" },
      request,
      fetcher,
    )
    expect(output).toContain("Google text")
    expect(output).not.toContain("private reasoning")
    expect(frames(output).at(-1)?.choices[0].finish_reason).toBe("tool_calls")
    const [url, init] = vi.mocked(fetcher).mock.calls[0]
    expect(String(url)).toBe(
      "https://provider.example/v1/models/fixture-model:streamGenerateContent?alt=sse",
    )
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(snapshot.modelKey)
    expect(JSON.parse(init?.body as string)).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      generationConfig: { maxOutputTokens: 2048 },
    })
  })

  it("bounds request bodies and upstream bytes", async () => {
    const fetcher = vi.fn(async () => sse([])) as unknown as typeof fetch
    await expect(
      collect(
        snapshot,
        { ...request, messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] },
        fetcher,
      ),
    ).rejects.toThrow("model_gateway_upstream_failed")
    expect(fetcher).not.toHaveBeenCalled()
    const oversized = (async () =>
      new Response(`data: ${"x".repeat(4 * 1024 * 1024)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch
    await expect(collect(snapshot, request, oversized)).rejects.toThrow(
      "model_gateway_upstream_failed",
    )
  })

  it("does not request with an empty key and removes upstream error details", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("fixture-secret upstream details")
    }) as unknown as typeof fetch
    await expect(collect({ ...snapshot, modelKey: "" }, request, fetcher)).rejects.toThrow(
      /^model_gateway_upstream_failed$/,
    )
    expect(fetcher).not.toHaveBeenCalled()
    await expect(collect(snapshot, request, fetcher)).rejects.toThrow(
      /^model_gateway_upstream_failed$/,
    )
    const badStatus = (async () => new Response("fixture-secret", { status: 401 })) as typeof fetch
    await expect(collect(snapshot, request, badStatus)).rejects.toThrow(
      /^model_gateway_upstream_failed$/,
    )
  })

  it("rejects undeclared provider tools and truncated Google streams", async () => {
    await expect(
      collect(snapshot, { ...request, tools: [] }, (async () =>
        sse(responsesEvents(true))) as typeof fetch),
    ).rejects.toThrow("model_gateway_upstream_failed")
    await expect(
      collect({ ...snapshot, modelApi: "google-generative-ai" }, request, (async () =>
        sse([])) as typeof fetch),
    ).rejects.toThrow("model_gateway_upstream_failed")
  })

  it("aborts before dispatch and during an active request", async () => {
    const controller = new AbortController()
    controller.abort()
    const unused = vi.fn() as unknown as typeof fetch
    await expect(collect(snapshot, request, unused, controller.signal)).rejects.toThrow(
      "model_gateway_upstream_failed",
    )
    expect(unused).not.toHaveBeenCalled()
    const active = new AbortController()
    const fetcher = vi.fn(async (_url, init) => {
      queueMicrotask(() => active.abort())
      return await new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("fixture-secret")), {
          once: true,
        }),
      )
    }) as unknown as typeof fetch
    await expect(collect(snapshot, request, fetcher, active.signal)).rejects.toThrow(
      /^model_gateway_upstream_failed$/,
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe("host-only adapter continuation state", () => {
  const echo = (id: string) => [
    { type: "toolCall" as const, id, name: "read", arguments: { path: "README.md" } },
  ]
  const content = (id: string, thinking = "private") => [
    { type: "thinking" as const, thinking, thinkingSignature: "dGhpbms=" },
    { ...echo(id)[0], thoughtSignature: "dG9vbA==" },
  ]

  it("replays native Responses IDs and encrypted reasoning after worker normalization", async () => {
    const config: ModelSnapshot = { ...snapshot, modelProvider: "openai" }
    const state = new AdapterState()
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "private reasoning" }],
      encrypted_content: "opaque-encrypted-reasoning",
    }
    const nativeText = { type: "message", id: "msg_native", role: "assistant", content: [] }
    const events = responsesEvents(true).map((event) => {
      const value = event as Record<string, unknown>
      return typeof value.output_index === "number"
        ? { ...value, output_index: value.output_index + 2 }
        : value
    })
    events.splice(
      1,
      0,
      { type: "response.output_item.added", output_index: 0, item: reasoning },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.added", output_index: 1, item: nativeText },
      { type: "response.output_text.delta", output_index: 1, delta: "Reading now" },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { ...nativeText, content: [{ type: "output_text", text: "Reading now" }] },
      },
    )
    const bodies: { input: unknown[] }[] = []
    const fetcher = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init?.body as string))
      return sse(bodies.length === 1 ? events : responsesEvents())
    }) as unknown as typeof fetch
    const first = await collect(config, request, fetcher, undefined, state)
    expect(first).not.toMatch(
      /\bcall_1\b|\bfc_1\b|rs_1|encrypted|private reasoning|fixture-secret|namespace/,
    )
    const call = frames(first).flatMap((frame) => frame.choices[0].delta.tool_calls ?? [])[0]
    expect(call.id).toMatch(/^call_[a-f0-9]{32}$/)
    expect(call.id.length).toBeLessThanOrEqual(40)
    // Foreign metadata triggers transformMessages' normalizer; worker-local
    // metadata bypasses it. The public ID must be unchanged in both paths.
    const next = workerTurn(first, config)
    expect(next).toEqual(workerTurn(first))
    expect(next.messages[1]).toMatchObject({ tool_calls: [{ id: call.id }] })
    expect(next.messages[2]).toMatchObject({ tool_call_id: call.id })
    // Confirm that the same worker converter would break an exposed native ID.
    const legacy = workerMessages(
      {
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1|fc_1", function: call.function }],
          },
          { role: "tool", tool_call_id: "call_1|fc_1", content: "File text" },
        ],
      },
      config,
    )
    expect(legacy[0]).toMatchObject({ tool_calls: [{ id: "call_1_fc_1" }] })
    const last = await collect(config, next, fetcher, undefined, state)
    expect(last).toContain("Hello back")
    expect(bodies[1].input).toEqual(
      expect.arrayContaining([
        reasoning,
        expect.objectContaining({
          type: "message",
          id: "msg_native",
          content: [{ type: "output_text", text: "Reading now", annotations: [] }],
        }),
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read",
          arguments: '{"path":"README.md"}',
        },
        { type: "function_call_output", call_id: "call_1", output: "File text" },
      ]),
    )
    expect(JSON.stringify(bodies[1])).not.toContain(call.id)
    // Without an explicit state, a standalone stream must not retain native parts.
    const stateless = workerTurn(
      await collect(config, request, (async () => sse(events)) as typeof fetch),
    )
    expect(JSON.stringify(toPiContext(config, stateless))).not.toMatch(
      /encrypted|rs_1|fc_1|msg_native/,
    )
  })

  it("replays Anthropic native tool IDs and signed/redacted thinking", async () => {
    const config: ModelSnapshot = {
      ...snapshot,
      modelApi: "anthropic-messages",
      modelProvider: "anthropic",
    }
    const state = new AdapterState()
    const native = [
      { type: "thinking", thinking: "private reasoning", signature: "signed-thinking" },
      { type: "redacted_thinking", data: "encrypted-thinking" },
      { type: "text", text: "Reading now" },
      { type: "tool_use", id: "toolu_native", name: "read", input: { path: "README.md" } },
    ]
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg",
          role: "assistant",
          content: [],
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
      ...native.flatMap((block, index) => [
        {
          type: "content_block_start",
          index,
          content_block:
            block.type === "tool_use"
              ? { ...block, input: {} }
              : block.type === "text"
                ? { ...block, text: "" }
                : block,
        },
        ...(block.type === "text"
          ? [
              {
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: block.text },
              },
            ]
          : []),
        ...(block.type === "tool_use"
          ? [
              {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
              },
            ]
          : []),
        { type: "content_block_stop", index },
      ]),
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ]
    const bodies: { messages: { role: string; content: unknown[] }[] }[] = []
    const fetcher = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init?.body as string))
      return sse(events)
    }) as unknown as typeof fetch
    const first = await collect(config, request, fetcher, undefined, state)
    expect(first).not.toMatch(/toolu_native|private reasoning|signed-thinking|encrypted-thinking/)
    const next = workerTurn(first)
    await collect(config, next, fetcher, undefined, state)
    expect(bodies[1].messages[1]).toEqual({ role: "assistant", content: native })
    expect(bodies[1].messages[2]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_native", content: "File text" }],
    })
  })

  it("validates public IDs, names, arguments, and text before restoring native content", () => {
    const state = new AdapterState()
    const native = [
      { type: "text" as const, text: "Reading now", textSignature: "host-only" },
      ...content("call_native|fc_native"),
    ]
    const ids = new Map([["call_native|fc_native", "call_public"]])
    state.remember(native, ids)
    const echoed = [{ type: "text" as const, text: "Reading now" }, ...echo("call_public")]
    expect(state.restore(echoed)).toEqual(native)
    for (const changed of [
      [{ type: "text" as const, text: "Changed" }, ...echo("call_public")],
      [echoed[0], { ...echo("call_public")[0], name: "bash" }],
      [echoed[0], { ...echo("call_public")[0], arguments: { path: "other" } }],
      [...echoed, ...echo("unknown")],
    ])
      expect(() => state.restore(changed)).toThrow("invalid_chat_context")
    // A native or unknown ID cannot authorize access to retained host content.
    expect(state.restore(echo("call_native|fc_native"))).toEqual(echo("call_native|fc_native"))
    expect(state.restore(echo("unknown"))).toEqual(echo("unknown"))
    state.clear()
    expect(state.restore(echo("call_public"))).toEqual(echo("call_public"))
  })

  it("maps distinct public IDs to native tool calls and results in reverse result order", () => {
    const state = new AdapterState()
    const native = [...content("call_shared|fc_first"), ...echo("call_shared|fc_second")]
    state.remember(
      native,
      new Map([
        ["call_shared|fc_first", "call_first"],
        ["call_shared|fc_second", "call_second"],
      ]),
    )
    const assistant = {
      role: "assistant",
      content: null,
      tool_calls: ["call_first", "call_second"].map((id) => ({
        id,
        type: "function",
        function: { name: "read", arguments: '{ "path": "README.md" }' },
      })),
    }
    const context = toPiContext(
      snapshot,
      {
        messages: [
          assistant,
          { role: "tool", tool_call_id: "call_second", content: "Second" },
          { role: "tool", tool_call_id: "call_first", content: "First" },
        ],
      },
      state,
    )
    expect(context.messages[0]).toMatchObject({ content: native })
    expect(context.messages[1]).toMatchObject({ toolCallId: "call_shared|fc_second" })
    expect(context.messages[2]).toMatchObject({ toolCallId: "call_shared|fc_first" })
    expect(() => state.restore(echo("call_first"))).toThrow("invalid_chat_context")
    expect(() => state.restore([...echo("call_second"), ...echo("call_first")])).toThrow(
      "invalid_chat_context",
    )
  })

  it("bounds retained response count and aggregate bytes, and closes permanently", () => {
    const countBound = new AdapterState()
    for (let index = 0; index < 25; index++) countBound.remember(content(`call_${index}`))
    expect(countBound.restore(echo("call_0"))).toEqual(echo("call_0"))
    expect(countBound.restore(echo("call_1"))).toEqual(content("call_1"))
    const byteBound = new AdapterState()
    byteBound.remember(content("first", "x".repeat(512 * 1024)))
    byteBound.remember(content("second", "x".repeat(512 * 1024)))
    expect(byteBound.restore(echo("first"))).toEqual(echo("first"))
    expect(byteBound.restore(echo("second"))).toHaveLength(2)
    byteBound.remember(content("oversized", "x".repeat(1024 * 1024)))
    expect(byteBound.restore(echo("oversized"))).toEqual(echo("oversized"))
    byteBound.clear()
    expect(byteBound.restore(echo("second"))).toEqual(echo("second"))
    byteBound.remember(content("late-stream"))
    expect(byteBound.restore(echo("late-stream"))).toEqual(echo("late-stream"))
  })

  it("rejects split, reordered, or combined known tool turns and returns detached parts", () => {
    const state = new AdapterState()
    const original = [...content("first"), ...echo("second")]
    state.remember(original)
    expect(() => state.restore(echo("first"))).toThrow("invalid_chat_context")
    expect(() => state.restore([...echo("second"), ...echo("first")])).toThrow(
      "invalid_chat_context",
    )
    expect(() => state.restore([...echo("first"), ...echo("unknown")])).toThrow(
      "invalid_chat_context",
    )
    const restored = state.restore([...echo("first"), ...echo("second")])
    expect(restored).toEqual(original)
    restored.pop()
    expect(state.restore([...echo("first"), ...echo("second")])).toEqual(original)
    expect(new AdapterState().restore(echo("first"))).toEqual(echo("first"))
  })

  it("bounds repeated restored turns and the final provider request body", async () => {
    const state = new AdapterState()
    state.remember(content("large", "x".repeat(600 * 1024)))
    const assistant = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "large",
          type: "function",
          function: { name: "read", arguments: '{"path":"README.md"}' },
        },
      ],
    }
    const result = { role: "tool", tool_call_id: "large", content: "File" }
    expect(() =>
      toPiContext(snapshot, { messages: [assistant, result, assistant, result] }, state),
    ).toThrow("invalid_chat_context")
    const fetcher = vi.fn() as unknown as typeof fetch
    await expect(
      collect(
        { ...snapshot, modelApi: "google-generative-ai" },
        {
          ...request,
          messages: [{ role: "user", content: "y".repeat(600 * 1024) }, assistant, result],
        },
        fetcher,
        new AbortController().signal,
        state,
      ),
    ).rejects.toThrow("model_gateway_upstream_failed")
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not retain tool parts from incomplete Responses responses", async () => {
    const state = new AdapterState()
    const remember = vi.spyOn(state, "remember")
    await expect(
      collect(
        snapshot,
        request,
        (async () => sse(responsesEvents(true).slice(0, -1))) as typeof fetch,
        undefined,
        state,
      ),
    ).rejects.toThrow("model_gateway_upstream_failed")
    expect(remember).not.toHaveBeenCalled()
  })

  it("does not retain tool parts from incomplete Google responses", async () => {
    const state = new AdapterState()
    const remember = vi.spyOn(state, "remember")
    await expect(
      collect(
        { ...snapshot, modelApi: "google-generative-ai" },
        request,
        (async () =>
          sse([
            {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: { name: "read", args: {}, id: "native-call" },
                        thoughtSignature: "dG9vbA==",
                      },
                    ],
                  },
                },
              ],
            },
          ])) as typeof fetch,
        new AbortController().signal,
        state,
      ),
    ).rejects.toThrow("model_gateway_upstream_failed")
    expect(remember).not.toHaveBeenCalled()
  })
})

describe("model gateway compatibility", () => {
  it("preserves the raw localhost fixture path and request restrictions without metadata", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reina-gateway-"))
    let upstreamBody: Record<string, unknown> | undefined
    let upstreamAuth: string | undefined
    const upstream = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString())
      upstreamAuth = req.headers.authorization
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end("data: [DONE]\n\n")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    if (!address || typeof address === "string") throw new Error("fixture_address_missing")
    const gateway = new ModelGateway(
      {
        model: snapshot.model,
        modelKey: snapshot.modelKey,
        modelUrl: `http://127.0.0.1:${address.port}/v1`,
      },
      path.join(directory, "model.sock"),
      { requests: 3, lifetimeMs: 10_000 },
    )
    const send = (body: object, capability = gateway.capability, url = "/v1/chat/completions") =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            socketPath: gateway.socketPath,
            path: url,
            method: "POST",
            headers: {
              authorization: `Bearer ${capability}`,
              "content-type": "application/json",
            },
          },
          (res) => {
            let value = ""
            res.on("data", (chunk) => {
              value += chunk
            })
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: value }))
            res.on("error", reject)
          },
        )
        req.on("error", reject)
        req.end(JSON.stringify(body))
      })
    try {
      await gateway.listen()
      expect((await send(request, "wrong-capability")).status).toBe(401)
      expect((await send(request, gateway.capability, "/other")).status).toBe(403)
      expect((await send({ ...request, base_url: "https://untrusted.example" })).status).toBe(400)
      expect((await send({ ...request, max_tokens: 999999 })).body).toBe("data: [DONE]\n\n")
      expect(upstreamAuth).toBe("Bearer fixture-secret")
      expect(upstreamBody).toMatchObject({
        model: snapshot.model,
        max_tokens: 4096,
        stream: true,
        store: false,
      })
      gateway.revoke()
      expect((await send(request)).status).toBe(401)
    } finally {
      await gateway.close()
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("streams the configured protocol through the safe-fetch adapter", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reina-gateway-pi-"))
    const fetcher = vi.fn(async () => sse(responsesEvents())) as unknown as typeof fetch
    const safeFetch = vi.spyOn(providerNetwork, "providerFetch").mockReturnValue(fetcher)
    const gateway = new ModelGateway(snapshot, path.join(directory, "model.sock"), {
      requests: 1,
      lifetimeMs: 10_000,
    })
    try {
      await gateway.listen()
      const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          {
            socketPath: gateway.socketPath,
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              authorization: `Bearer ${gateway.capability}`,
              "content-type": "application/json",
            },
          },
          (res) => {
            let body = ""
            res.on("data", (chunk) => {
              body += chunk
            })
            res.on("error", reject)
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
          },
        )
        req.on("error", reject)
        req.end(JSON.stringify(request))
      })
      expect(result.status).toBe(200)
      expect(result.body).toContain("Hello back")
      expect(result.body).toContain("data: [DONE]")
      expect(safeFetch).toHaveBeenCalledWith(snapshot.modelUrl)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      safeFetch.mockRestore()
      await gateway.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("replays signed Google assistant parts only inside the pinned gateway", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "reina-gateway-google-"))
    const config: ModelSnapshot = {
      ...snapshot,
      model: "gemini-3-flash-preview",
      modelApi: "google-generative-ai",
      modelProvider: "google",
    }
    const signedParts = [
      { text: "Reading ", thoughtSignature: "dGV4dDE=" },
      { text: "now", thoughtSignature: "dGV4dDI=" },
      { text: "private reasoning", thought: true, thoughtSignature: "dGhpbms=" },
      { text: "", thoughtSignature: "ZW1wdHk=" },
      {
        functionCall: { name: "read", args: { path: "README.md" } },
        thoughtSignature: "dG9vbA==",
      },
    ]
    const bodies: { contents: { role: string; parts: unknown[] }[] }[] = []
    const fetcher = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init?.body as string))
      return sse([
        {
          candidates: [
            {
              content: { parts: bodies.length === 1 ? signedParts : [{ text: "File summary" }] },
              finishReason: "STOP",
            },
          ],
        },
      ])
    }) as unknown as typeof fetch
    const safeFetch = vi.spyOn(providerNetwork, "providerFetch").mockReturnValue(fetcher)
    const cleared = vi.spyOn(AdapterState.prototype, "clear")
    const gateway = new ModelGateway(config, path.join(directory, "model.sock"), {
      requests: 8,
      lifetimeMs: 10_000,
    })
    const isolated = new ModelGateway({ ...config }, path.join(directory, "isolated.sock"), {
      requests: 1,
      lifetimeMs: 10_000,
    })
    const body = { ...request, model: config.model }
    // Mutating the caller's selection must not change either gateway's snapshot.
    config.model = "changed-model"
    config.modelKey = "changed-secret"
    config.modelApi = "openai-responses"
    try {
      await gateway.listen()
      await isolated.listen()
      const first = await sendGateway(gateway, body)
      expect(first.status).toBe(200)
      expect(first.body).toContain("Reading ")
      expect(first.body).not.toMatch(/thoughtSignature|private reasoning|dG9vbA==/)
      const call = frames(first.body).flatMap((frame) => frame.choices[0].delta.tool_calls ?? [])[0]
      expect(call.id).toMatch(/^call_/)
      const assistant = {
        role: "assistant",
        content: "Reading now",
        tool_calls: [
          {
            id: call.id,
            type: call.type,
            function: { ...call.function, arguments: '{ "path": "README.md" }' },
          },
        ],
      }
      const continuation = (echo = assistant) => ({
        ...body,
        messages: [
          ...body.messages,
          echo,
          { role: "tool", tool_call_id: call.id, content: "File text" },
        ],
      })
      for (const echo of [
        { ...assistant, content: "Changed text" },
        {
          ...assistant,
          tool_calls: [{ ...assistant.tool_calls[0], function: { name: "bash", arguments: "{}" } }],
        },
        {
          ...assistant,
          tool_calls: [
            {
              ...assistant.tool_calls[0],
              function: { name: "read", arguments: '{"path":"other"}' },
            },
          ],
        },
      ]) {
        expect((await sendGateway(gateway, continuation(echo))).status).toBe(400)
      }
      expect(fetcher).toHaveBeenCalledTimes(1)
      const final = await sendGateway(gateway, continuation())
      expect(final.status).toBe(200)
      expect(final.body).toContain("File summary")
      expect(final.body).toContain("data: [DONE]")
      expect(final.body).not.toMatch(/thoughtSignature|private reasoning/)
      expect(bodies[1].contents[1]).toEqual({
        role: "model",
        parts: [
          ...signedParts.slice(0, -1),
          { ...signedParts[4], functionCall: { ...signedParts[4].functionCall, id: call.id } },
        ],
      })
      expect(bodies[1].contents[2]).toMatchObject({
        role: "user",
        parts: [
          { functionResponse: { id: call.id, name: "read", response: { output: "File text" } } },
        ],
      })
      expect(new Headers(vi.mocked(fetcher).mock.calls[1][1]?.headers).get("x-goog-api-key")).toBe(
        snapshot.modelKey,
      )
      expect((await sendGateway(isolated, continuation())).status).toBe(200)
      expect(JSON.stringify(bodies[2])).not.toMatch(/thoughtSignature|private reasoning/)
      gateway.revoke()
      expect(cleared).toHaveBeenCalledTimes(1)
      expect((await sendGateway(gateway, continuation())).status).toBe(401)
    } finally {
      safeFetch.mockRestore()
      cleared.mockRestore()
      await gateway.close()
      await isolated.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("rejects configured private destinations and unsupported protocols", () => {
    expect(
      () =>
        new ModelGateway({ ...snapshot, modelUrl: "http://127.0.0.1/v1" }, "/unused", {
          requests: 1,
          lifetimeMs: 1000,
        }),
    ).toThrow()
    expect(
      () =>
        new ModelGateway({ ...snapshot, modelUrl: "https://127.0.0.1/v1" }, "/unused", {
          requests: 1,
          lifetimeMs: 1000,
        }),
    ).toThrow()
  })
})

function accountEvents(api: Api, tool: boolean, oauthAnthropic = false): unknown[] {
  if (api === "anthropic-messages") {
    const blocks = tool
      ? [
          { type: "thinking", thinking: "private reasoning", signature: "private-signature" },
          {
            type: "tool_use",
            id: "native-payload-tool-id",
            name: oauthAnthropic ? "Read" : "read",
            input: {},
          },
        ]
      : [{ type: "text", text: "" }]
    return [
      {
        type: "message_start",
        message: { id: "private-message-id", role: "assistant", content: [], usage: {} },
      },
      ...blocks.flatMap((block, index) => [
        { type: "content_block_start", index, content_block: block },
        ...(block.type === "tool_use"
          ? [
              {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' },
              },
            ]
          : block.type === "text"
            ? [
                {
                  type: "content_block_delta",
                  index,
                  delta: { type: "text_delta", text: "Hello back" },
                },
              ]
            : []),
        { type: "content_block_stop", index },
      ]),
      {
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn" },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ]
  }
  if (api === "openai-completions") {
    return [
      {
        id: "private-message-id",
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  role: "assistant",
                  reasoning_content: "private reasoning",
                  tool_calls: [
                    {
                      index: 0,
                      id: "native-payload-tool-id",
                      type: "function",
                      function: { name: "read", arguments: '{"path":"README.md"}' },
                    },
                  ],
                }
              : { role: "assistant", content: "Hello back" },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    ]
  }
  const events = responsesEvents(tool).map((event) => {
    const value = event as Record<string, unknown>
    return typeof value.output_index === "number"
      ? { ...value, output_index: value.output_index + 1 }
      : value
  })
  const reasoning = {
    type: "reasoning",
    id: "private-reasoning-id",
    summary: [{ type: "summary_text", text: "private reasoning" }],
    encrypted_content: "private-encrypted-content",
  }
  events.splice(
    1,
    0,
    { type: "response.output_item.added", output_index: 0, item: reasoning },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
  )
  return events
}

const accountCases: { provider: string; api: SupportedApi }[] = [
  { provider: "openai-codex", api: "openai-codex-responses" },
  { provider: "anthropic", api: "anthropic-messages" },
  { provider: "github-copilot", api: "openai-completions" },
  { provider: "github-copilot", api: "anthropic-messages" },
  { provider: "github-copilot", api: "openai-responses" },
  { provider: "kimi-coding", api: "openai-completions" },
  { provider: "meta", api: "openai-responses" },
  { provider: "xai", api: "openai-responses" },
]

function accountFixture(providerId: string, api: SupportedApi) {
  const provider = getBuiltinProvider(providerId)
  const modelId = provider?.getModels().find((model) => model.api === api)?.id
  const original = modelId ? getBuiltinModel(providerId, modelId) : undefined
  if (!provider?.auth.oauth || !original) throw new Error("missing_account_fixture")
  const oauth = provider.auth.oauth
  const credentials: OAuthCredential[] = []
  const resolveModelRequest = vi.fn(async (signal: AbortSignal): Promise<ModelRequest> => {
    signal.throwIfAborted()
    const generation = credentials.length + 1
    let access = `fixture-access-${providerId}-${generation}`
    if (providerId === "anthropic") access = `sk-ant-oat-${access}`
    if (providerId === "github-copilot")
      access += ";tid=fixture-tenant;proxy-ep=proxy.business.githubcopilot.com"
    if (providerId === "openai-codex") {
      const payload = Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account-id" },
          fixtureGeneration: generation,
        }),
      ).toString("base64url")
      access = `e30.${payload}.fixture-signature`
    }
    const credential: OAuthCredential = {
      type: "oauth",
      access,
      refresh: "fixture-refresh-secret",
      expires: 9_999_999_999_999,
    }
    credentials.push(credential)
    // Only the SDK's side-effect-free auth conversion is used; login/refresh use no network here.
    const auth = await oauth.toAuth(credential)
    return {
      model: { ...original, baseUrl: auth.baseUrl ?? original.baseUrl },
      auth: { ...auth, headers: { ...auth.headers, "x-fixture-generation": String(generation) } },
      env: {},
    }
  })
  const config: ModelSnapshot = {
    model: original.id,
    modelApi: api,
    modelProvider: providerId,
    modelUrl: original.baseUrl,
    modelKey: "",
    contextWindow: original.contextWindow,
    maxTokens: 1024,
    resolveModelRequest,
  }
  return { config, original, credentials, resolveModelRequest }
}

function wireBody(init?: RequestInit): Record<string, unknown> {
  const body = init?.body
  return JSON.parse(
    typeof body === "string" ? body : zstdDecompressSync(body as Uint8Array).toString(),
  )
}

describe("host-only account requests", () => {
  it.each(accountCases)(
    "continues $provider/$api with SDK auth, headers, and native parts",
    async ({ provider, api }) => {
      const { config, original, credentials, resolveModelRequest } = accountFixture(provider, api)
      const state = new AdapterState()
      const bodies: Record<string, unknown>[] = []
      const fetcher = vi.fn(async (_url, init) => {
        bodies.push(wireBody(init))
        return sse(accountEvents(api, bodies.length === 1, provider === "anthropic"))
      }) as unknown as typeof fetch
      const safeFetch = vi.spyOn(providerNetwork, "providerFetch").mockReturnValue(fetcher)
      try {
        const first = await collect(
          config,
          { ...request, model: config.model },
          undefined,
          undefined,
          state,
        )
        const second = await collect(
          config,
          { ...workerTurn(first, config), model: config.model },
          undefined,
          undefined,
          state,
        )
        expect(second).toContain("Hello back")
        expect(resolveModelRequest).toHaveBeenCalledTimes(2)
        expect(resolveModelRequest.mock.calls[0][0]).toBeInstanceOf(AbortSignal)
        const publicCall = frames(first).flatMap(
          (frame) => frame.choices[0].delta.tool_calls ?? [],
        )[0]
        expect(publicCall.id).toMatch(/^call_[a-f0-9]{32}$/)
        expect(first + second).not.toMatch(
          /fixture-access|fixture-refresh|fixture-account|fixture-tenant|fixture-signature|native-payload|private-|private reasoning|\bcall_1\b|\bfc_1\b/,
        )
        expect(JSON.stringify(workerTurn(first, config))).not.toMatch(
          /fixture-access|private-|native-payload/,
        )
        expect(JSON.stringify(bodies[1])).not.toContain(publicCall.id)
        expect(JSON.stringify(bodies[1])).toContain(
          api.includes("responses") ? "call_1" : "native-payload-tool-id",
        )
        if (api !== "openai-completions")
          expect(JSON.stringify(bodies[1])).toContain(
            api === "anthropic-messages" ? "private-signature" : "private-encrypted-content",
          )
        for (const [index, call] of vi.mocked(fetcher).mock.calls.entries()) {
          const [url, init] = call
          const headers = new Headers(init?.headers)
          const destination =
            provider === "github-copilot"
              ? "https://api.business.githubcopilot.com"
              : original.baseUrl
          expect(safeFetch).toHaveBeenNthCalledWith(index + 1, destination)
          expect(String(url)).toContain(destination)
          expect(init?.redirect).toBe("error")
          expect(headers.get("authorization")).toBe(`Bearer ${credentials[index].access}`)
          expect(headers.get("x-fixture-generation")).toBe(String(index + 1))
          for (const [name, value] of Object.entries(original.headers ?? {})) {
            if (value !== null) expect(headers.get(name)).toBe(value)
          }
          expect(bodies[index]).toMatchObject({ model: original.id, stream: true })
          const cap =
            bodies[index].max_tokens ??
            bodies[index].max_completion_tokens ??
            bodies[index].max_output_tokens
          if (api === "openai-codex-responses") expect(cap).toBeUndefined()
          else expect(cap).toBe(1024)
          expect(JSON.stringify(bodies[index])).not.toContain("cache_control")
          if (provider === "anthropic") {
            expect(headers.get("anthropic-beta")).toContain("oauth-2025-04-20")
            expect(headers.get("x-api-key")).toBeNull()
            expect(bodies[index].tools).toEqual(
              expect.arrayContaining([expect.objectContaining({ name: "Read" })]),
            )
          }
          if (provider === "openai-codex") {
            expect(String(url)).toBe(`${original.baseUrl}/codex/responses`)
            expect(headers.get("chatgpt-account-id")).toBe("fixture-account-id")
            expect(headers.get("openai-beta")).toBe("responses=experimental")
            expect(bodies[index]).toMatchObject({ store: false })
            expect(bodies[index].max_output_tokens).toBeUndefined()
            expect(bodies[index].prompt_cache_key).toBeUndefined()
          }
          if (provider === "kimi-coding") {
            expect(bodies[index].max_tokens).toBe(1024)
            expect(bodies[index].max_completion_tokens).toBeUndefined()
            expect(bodies[index].store).toBeUndefined()
            if (index === 1) expect(JSON.stringify(bodies[index])).toContain("private reasoning")
          }
          if (provider === "github-copilot")
            expect(headers.get("x-initiator")).toBe(index === 0 ? "user" : "agent")
        }
      } finally {
        safeFetch.mockRestore()
      }
    },
  )

  it.each(accountCases)(
    "does not dispatch $provider/$api after refresh failure or revocation",
    async ({ provider, api }) => {
      const { config, resolveModelRequest } = accountFixture(provider, api)
      const fetcher = vi.fn() as unknown as typeof fetch
      resolveModelRequest.mockRejectedValue(new Error("fixture-refresh-secret reconnect details"))
      await expect(
        collect({ ...config, modelKey: "must-not-fallback" }, request, fetcher),
      ).rejects.toThrow(/^model_gateway_upstream_failed$/)
      const controller = new AbortController()
      controller.abort()
      await expect(collect(config, request, fetcher, controller.signal)).rejects.toThrow(
        /^model_gateway_upstream_failed$/,
      )
      expect(resolveModelRequest).toHaveBeenCalledTimes(1)
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it("rejects model, provider, protocol, and unsafe or unprepared endpoint changes", async () => {
    const { config, resolveModelRequest } = accountFixture("kimi-coding", "openai-completions")
    const prepared = await resolveModelRequest(new AbortController().signal)
    const fetcher = vi.fn() as unknown as typeof fetch
    for (const change of [
      { id: "another-model" },
      { provider: "another-account-provider" },
      { api: "openai-responses" },
      { baseUrl: "https://different.example/v1" },
      { baseUrl: "https://127.0.0.1/v1" },
      { baseUrl: "https://localhost/v1" },
      { baseUrl: "https://provider.example/v1?token=fixture-secret" },
      { baseUrl: "https://fixture-secret@provider.example/v1" },
    ]) {
      await expect(
        collect(
          {
            ...config,
            resolveModelRequest: async () => ({
              ...prepared,
              model: { ...prepared.model, ...change },
            }),
          },
          request,
          fetcher,
        ),
      ).rejects.toThrow(/^model_gateway_upstream_failed$/)
    }
    await expect(
      collect(
        {
          ...config,
          resolveModelRequest: async () => ({
            ...prepared,
            auth: { ...prepared.auth, baseUrl: "https://different.example/v1" },
          }),
        },
        request,
        fetcher,
      ),
    ).rejects.toThrow(/^model_gateway_upstream_failed$/)
    for (const baseUrl of [
      "https://127.0.0.1/v1",
      "http://provider.example/v1",
      "https://provider.example/v1?token=fixture-secret",
    ]) {
      await expect(
        collect(
          {
            ...config,
            resolveModelRequest: async () => ({
              ...prepared,
              model: { ...prepared.model, baseUrl },
              auth: { ...prepared.auth, baseUrl },
            }),
          },
          request,
          fetcher,
        ),
      ).rejects.toThrow(/^model_gateway_upstream_failed$/)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("rejects malformed history before credential refresh", async () => {
    const { config, resolveModelRequest } = accountFixture("kimi-coding", "openai-completions")
    const fetcher = vi.fn() as unknown as typeof fetch
    for (const messages of [
      [{ role: "tool", tool_call_id: "unknown", content: "result" }],
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c", function: { name: "read", arguments: "[]" } }],
        },
      ],
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c", function: { name: "read", arguments: "{}" } }],
        },
        { role: "user", content: "missing result" },
      ],
    ])
      await expect(collect(config, { ...request, messages }, fetcher)).rejects.toThrow(
        /^model_gateway_upstream_failed$/,
      )
    expect(resolveModelRequest).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("propagates cancellation while resolving and never dispatches a late result", async () => {
    const { config, resolveModelRequest } = accountFixture("kimi-coding", "openai-completions")
    const prepared = await resolveModelRequest(new AbortController().signal)
    const controller = new AbortController()
    let release: (value: ModelRequest) => void = () => {}
    let observed: AbortSignal | undefined
    const fetcher = vi.fn() as unknown as typeof fetch
    const pending = collect(
      {
        ...config,
        resolveModelRequest: (signal) => {
          observed = signal
          return new Promise((resolve) => {
            release = resolve
          })
        },
      },
      request,
      fetcher,
      controller.signal,
    )
    controller.abort()
    await expect(pending).rejects.toThrow(/^model_gateway_upstream_failed$/)
    expect(observed?.aborted).toBe(true)
    release(prepared)
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(accountCases)(
    "does not retry or fall back on a $provider/$api upstream failure",
    async ({ provider, api }) => {
      const { config } = accountFixture(provider, api)
      const fetcher = vi.fn(
        async () => new Response("fixture-access raw upstream details", { status: 503 }),
      ) as unknown as typeof fetch
      await expect(collect(config, request, fetcher)).rejects.toThrow(
        /^model_gateway_upstream_failed$/,
      )
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )

  it("does not use ambient keys for missing resolved auth or failed resolution", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-openai-secret")
    vi.stubEnv("ANTHROPIC_API_KEY", "ambient-anthropic-secret")
    vi.stubEnv("KIMI_API_KEY", "ambient-kimi-secret")
    vi.stubEnv("HTTPS_PROXY", "http://ambient-proxy.invalid")
    const fetcher = vi.fn(async () =>
      sse(accountEvents("openai-completions", false)),
    ) as unknown as typeof fetch
    try {
      const { config, resolveModelRequest } = accountFixture("kimi-coding", "openai-completions")
      await collect(config, request, fetcher)
      const headers = new Headers(vi.mocked(fetcher).mock.calls[0][1]?.headers)
      expect(headers.get("authorization")).toBe("Bearer fixture-access-kimi-coding-1")
      expect(JSON.stringify(vi.mocked(fetcher).mock.calls)).not.toContain("ambient-")
      const prepared = await resolveModelRequest(new AbortController().signal)
      await expect(
        collect(
          { ...config, resolveModelRequest: async () => ({ ...prepared, auth: {} }) },
          request,
          fetcher,
        ),
      ).rejects.toThrow(/^model_gateway_upstream_failed$/)
      await expect(
        collect(
          { ...config, resolveModelRequest: async () => undefined as unknown as ModelRequest },
          request,
          fetcher,
        ),
      ).rejects.toThrow(/^model_gateway_upstream_failed$/)
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("applies its request timeout to credential resolution", async () => {
    const { config } = accountFixture("kimi-coding", "openai-completions")
    const timeout = new AbortController()
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal)
    const fetcher = vi.fn() as unknown as typeof fetch
    let observed: AbortSignal | undefined
    try {
      const pending = collect(
        {
          ...config,
          resolveModelRequest: (signal) => {
            observed = signal
            return new Promise(() => {})
          },
        },
        request,
        fetcher,
      )
      expect(deadline).toHaveBeenCalledWith(60_000)
      timeout.abort()
      await expect(pending).rejects.toThrow(/^model_gateway_upstream_failed$/)
      expect(observed?.aborted).toBe(true)
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      deadline.mockRestore()
    }
  })

  it("bounds Codex request and ignored reasoning bytes without adding unsupported token fields", async () => {
    const { config } = accountFixture("openai-codex", "openai-codex-responses")
    const fetcher = vi.fn() as unknown as typeof fetch
    await expect(
      collect(
        config,
        { ...request, messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] },
        fetcher,
      ),
    ).rejects.toThrow(/^model_gateway_upstream_failed$/)
    expect(fetcher).not.toHaveBeenCalled()
    const oversized = vi.fn(async () =>
      sse([
        {
          type: "response.created",
          response: { id: "private-response", ignored: "x".repeat(4 * 1024 * 1024) },
        },
      ]),
    ) as unknown as typeof fetch
    await expect(collect(config, request, oversized)).rejects.toThrow(
      /^model_gateway_upstream_failed$/,
    )
    expect(oversized).toHaveBeenCalledTimes(1)
    const body = wireBody(vi.mocked(oversized).mock.calls[0][1])
    expect(body.max_output_tokens).toBeUndefined()
    expect(body.max_tokens).toBeUndefined()
  })

  it("aborts in-flight gateway credential resolution on revocation", async () => {
    const { config } = accountFixture("kimi-coding", "openai-completions")
    const directory = await mkdtemp(path.join(tmpdir(), "reina-account-revoke-"))
    let observed: AbortSignal | undefined
    let started: () => void = () => {}
    const resolving = new Promise<void>((resolve) => {
      started = resolve
    })
    const fetcher = vi.fn() as unknown as typeof fetch
    const safeFetch = vi.spyOn(providerNetwork, "providerFetch").mockReturnValue(fetcher)
    const gateway = new ModelGateway(
      {
        ...config,
        resolveModelRequest: (signal) => {
          observed = signal
          started()
          return new Promise(() => {})
        },
      },
      path.join(directory, "model.sock"),
      { requests: 1, lifetimeMs: 10_000 },
    )
    try {
      await gateway.listen()
      const pending = sendGateway(gateway, { ...request, model: config.model })
      const rejected = expect(pending).rejects.toThrow()
      await resolving
      gateway.revoke()
      await rejected
      expect(observed?.aborted).toBe(true)
      expect(fetcher).not.toHaveBeenCalled()
      expect(safeFetch).not.toHaveBeenCalled()
    } finally {
      safeFetch.mockRestore()
      await gateway.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(["kimi-coding", "github-copilot"])(
    "uses SDK Completions for keyless %s gateway requests and binds the resolved endpoint",
    async (provider) => {
      const { config, credentials } = accountFixture(provider, "openai-completions")
      const directory = await mkdtemp(path.join(tmpdir(), "reina-account-gateway-"))
      const fetcher = vi.fn(async () =>
        sse(accountEvents("openai-completions", false)),
      ) as unknown as typeof fetch
      const safeFetch = vi.spyOn(providerNetwork, "providerFetch").mockReturnValue(fetcher)
      const gateway = new ModelGateway(config, path.join(directory, "model.sock"), {
        requests: 2,
        lifetimeMs: 10_000,
      })
      try {
        await gateway.listen()
        const result = await sendGateway(gateway, {
          ...request,
          model: config.model,
          max_tokens: 999_999,
        })
        expect(result.status).toBe(200)
        expect(result.body).toContain("Hello back")
        expect(result.body).not.toContain("fixture-access")
        expect(safeFetch).toHaveBeenCalledWith(
          provider === "github-copilot"
            ? "https://api.business.githubcopilot.com"
            : config.modelUrl,
        )
        const init = vi.mocked(fetcher).mock.calls[0][1]
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Bearer ${credentials[0].access}`,
        )
        const body = wireBody(init)
        expect(body.max_tokens ?? body.max_completion_tokens).toBe(1024)
        gateway.revoke()
        expect((await sendGateway(gateway, { ...request, model: config.model })).status).toBe(401)
        expect(fetcher).toHaveBeenCalledTimes(1)
      } finally {
        safeFetch.mockRestore()
        await gateway.close()
        await rm(directory, { recursive: true, force: true })
      }
      expect(
        () =>
          new ModelGateway({ ...config, resolveModelRequest: undefined }, "/unused", {
            requests: 1,
            lifetimeMs: 1000,
          }),
      ).toThrow("invalid_model_endpoint")
    },
  )
})

describe("static model catalog", () => {
  it("contains supported text chat models with their native protocol and auth methods", () => {
    const { providers } = modelCatalog()
    const source = builtinProviders()
    expect(providers.length).toBeGreaterThan(0)
    expect(new Set(providers.map((provider) => provider.id)).size).toBe(providers.length)
    expect(providers.find((provider) => provider.id === "openai-codex")?.authMethods).toEqual([
      "oauth",
    ])
    for (const provider of providers) {
      const original = source.find((candidate) => provider.id === candidate.id)
      if (!original) throw new Error("catalog_provider_missing")
      expect(provider.authMethods.length).toBeGreaterThan(0)
      for (const method of provider.authMethods)
        expect(original.auth[method === "api_key" ? "apiKey" : "oauth"]).toBeTruthy()
      for (const model of provider.models) {
        expect(supportedApis).toContain(model.api)
        expect(model.baseUrl).toMatch(/^https:\/\//)
        const match = original
          .getModels()
          .find(
            (candidate) =>
              candidate.id === model.id &&
              candidate.api === model.api &&
              candidate.baseUrl === model.baseUrl,
          )
        expect(match?.input).toContain("text")
        expect(model.maxTokens).toBe(match?.maxTokens)
        expect(model.maxTokens).toBeGreaterThanOrEqual(256)
      }
    }
  })
})
