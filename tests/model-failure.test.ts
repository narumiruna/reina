import { mkdtemp, rm } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { ModelGateway } from "../src/agent/model-gateway.js"
import { type ModelSnapshot, piChatStream } from "../src/agent/pi-adapter.js"
import * as providerNetwork from "../src/settings/network.js"
import { supportedApis } from "../src/settings/schema.js"

type Reply = { status: number; contentType?: string; body?: string } | "reset" | "truncate" | "hang"

const request = {
  model: "fixture-model",
  stream: true,
  messages: [{ role: "user", content: "Hello" }],
}
const snapshot: ModelSnapshot = {
  model: request.model,
  modelUrl: "https://provider.example/v1",
  modelKey: "fixture-key",
  modelProvider: "fixture",
  modelApi: "openai-responses",
}
const googleDone = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Done" }] }, finishReason: "STOP" }] })}\n\n`

/** All network traffic in these fixtures terminates on this local server. */
async function fixture(
  run: (fixture: {
    url: string
    reply: (value: Reply) => void
    count: () => number
    received: () => Promise<void>
    fetcher: typeof fetch
  }) => Promise<void>,
) {
  let reply: Reply = { status: 503 }
  let count = 0
  let received: () => void = () => {}
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      // Consume the real SDK/gateway request body before sending the fixture response.
    }
    count++
    received()
    if (reply === "reset") return req.socket.destroy()
    if (reply === "hang") return
    if (reply === "truncate") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(": started\n\n")
      setImmediate(() => res.destroy())
      return
    }
    res.writeHead(reply.status, { "content-type": reply.contentType ?? "text/event-stream" })
    res.end(reply.body ?? "data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("fixture_address_missing")
  const url = `http://127.0.0.1:${address.port}/v1`
  const fetcher: typeof fetch = (_input, init) => fetch(`${url}/fixture`, init)
  try {
    await run({
      url,
      reply: (value) => {
        reply = value
      },
      count: () => count,
      received: () =>
        new Promise<void>((resolve) => {
          received = resolve
        }),
      fetcher,
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function gatewayFixture(
  config: ModelSnapshot,
  run: (gateway: ModelGateway) => Promise<void>,
  lifetimeMs = 120_000,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "reina-model-failure-"))
  const gateway = new ModelGateway(config, path.join(directory, "model.sock"), {
    requests: 24,
    lifetimeMs,
  })
  try {
    await gateway.listen()
    await run(gateway)
  } finally {
    await gateway.close()
    await rm(directory, { recursive: true, force: true })
  }
}

function send(gateway: ModelGateway, body: object = request) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = http.request(
      {
        socketPath: gateway.socketPath,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          authorization: `Bearer ${gateway.capability}`,
          "content-type": "application/json",
        },
      },
      (response) => {
        let body = ""
        response.on("data", (chunk) => {
          body += chunk
        })
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body }))
        response.once("error", reject)
      },
    )
    outgoing.once("error", reject)
    outgoing.end(JSON.stringify(body))
  })
}

async function collect(
  config: ModelSnapshot,
  fetcher: typeof fetch,
  failed: () => void,
  signal = new AbortController().signal,
  data: Record<string, unknown> = request,
) {
  let output = ""
  for await (const chunk of piChatStream(config, data, signal, fetcher, undefined, failed))
    output += chunk
  return output
}

describe("host-owned raw model failures", () => {
  it("classifies actual upstream status, resets stale state, and never retries", async () => {
    await fixture(async (upstream) => {
      await gatewayFixture(
        { ...snapshot, modelApi: undefined, modelUrl: upstream.url },
        async (gateway) => {
          for (const [status, retryable] of [
            [503, true],
            [401, false],
            [408, true],
            [403, false],
            [429, true],
            [404, false],
            [500, true],
            [599, true],
            [400, false],
          ] as const) {
            upstream.reply({ status })
            const count = upstream.count()
            expect((await send(gateway)).status).toBe(502)
            expect(gateway.retryableFailure).toBe(retryable)
            expect(upstream.count()).toBe(count + 1)
          }
          upstream.reply({ status: 503 })
          await send(gateway)
          expect(gateway.retryableFailure).toBe(true)
          upstream.reply({ status: 200 })
          expect((await send(gateway)).status).toBe(200)
          expect(gateway.retryableFailure).toBe(false)
        },
      )
    })
  })

  it("classifies real connection resets and response transport truncation", async () => {
    await fixture(async (upstream) => {
      await gatewayFixture(
        { ...snapshot, modelApi: undefined, modelUrl: upstream.url },
        async (gateway) => {
          upstream.reply("reset")
          expect((await send(gateway)).status).toBe(502)
          expect(gateway.retryableFailure).toBe(true)
          upstream.reply("truncate")
          await expect(send(gateway)).rejects.toThrow()
          expect(gateway.retryableFailure).toBe(true)
          expect(upstream.count()).toBe(2)
        },
      )
    })
  })

  it.each([
    [120_000, true],
    [10_000, false],
  ] as const)(
    "records only the raw upstream's full 60-second timeout (%d ms lifetime)",
    async (lifetimeMs, retryable) => {
      await fixture(async (upstream) => {
        upstream.reply("hang")
        const outgoing = vi.spyOn(http, "request")
        try {
          await gatewayFixture(
            { ...snapshot, modelApi: undefined, modelUrl: upstream.url },
            async (gateway) => {
              const received = upstream.received()
              const pending = send(gateway)
              await received
              const index = outgoing.mock.calls.findIndex(([target]) => target instanceof URL)
              const upstreamRequest = outgoing.mock.results[index]?.value
              if (!upstreamRequest) throw new Error("fixture_request_missing")
              upstreamRequest.emit("timeout")
              expect((await pending).status).toBe(502)
              expect(gateway.retryableFailure).toBe(retryable)
              expect(upstream.count()).toBe(1)
            },
            lifetimeMs,
          )
        } finally {
          outgoing.mockRestore()
        }
      })
    },
  )

  it("clears prior evidence before bad worker history and does not dispatch it", async () => {
    await fixture(async (upstream) => {
      await gatewayFixture(
        { ...snapshot, modelApi: undefined, modelUrl: upstream.url },
        async (gateway) => {
          await send(gateway)
          expect(gateway.retryableFailure).toBe(true)
          expect(
            (
              await send(gateway, {
                ...request,
                messages: [{ role: "tool", content: "result", tool_call_id: "orphan" }],
              })
            ).status,
          ).toBe(400)
          expect(gateway.retryableFailure).toBe(false)
          expect(upstream.count()).toBe(1)
          expect((await send(gateway, { ...request, model: "wrong" })).status).toBe(400)
          expect(gateway.retryableFailure).toBe(false)
        },
      )
    })
  })

  it("does not confuse the host request budget with upstream rate limiting", async () => {
    await fixture(async (upstream) => {
      await gatewayFixture(
        { ...snapshot, modelApi: undefined, modelUrl: upstream.url },
        async (gateway) => {
          for (let index = 0; index < 24; index++) await send(gateway)
          expect(gateway.retryableFailure).toBe(true)
          expect((await send(gateway)).status).toBe(429)
          expect(gateway.retryableFailure).toBe(false)
          expect(upstream.count()).toBe(24)
        },
      )
    })
  })

  it("does not classify content types, response limits, or revocation as transient", async () => {
    await fixture(async (upstream) => {
      await gatewayFixture(
        { ...snapshot, modelApi: undefined, modelUrl: upstream.url },
        async (gateway) => {
          upstream.reply({ status: 200, contentType: "application/json" })
          expect((await send(gateway)).status).toBe(502)
          expect(gateway.retryableFailure).toBe(false)
          upstream.reply({ status: 200, body: `: ${"x".repeat(4 * 1024 * 1024)}\n\n` })
          await expect(send(gateway)).rejects.toThrow()
          expect(gateway.retryableFailure).toBe(false)
          upstream.reply({ status: 503 })
          await send(gateway)
          expect(gateway.retryableFailure).toBe(true)
          upstream.reply("hang")
          const received = upstream.received()
          const rejected = expect(send(gateway)).rejects.toThrow()
          await received
          expect(gateway.retryableFailure).toBe(false)
          gateway.revoke()
          await rejected
          expect(gateway.retryableFailure).toBe(false)
        },
      )
    })
  })
})

describe("host-owned SDK model failures", () => {
  it.each(supportedApis)(
    "classifies actual fetch responses for %s before SDK error flattening",
    async (api) => {
      await fixture(async (upstream) => {
        // Codex requires a structurally valid account token. This token is local fixture data.
        const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`
        const config = { ...snapshot, modelApi: api, modelKey: token }
        for (const [status, retryable] of [
          [503, true],
          [401, false],
          [408, true],
          [429, true],
        ] as const) {
          const failed = vi.fn()
          upstream.reply({ status, contentType: "application/json", body: '{"error":"fixture"}' })
          const count = upstream.count()
          await expect(collect(config, upstream.fetcher, failed)).rejects.toThrow(
            /^model_gateway_upstream_failed$/,
          )
          expect(failed).toHaveBeenCalledTimes(retryable ? 1 : 0)
          expect(upstream.count()).toBe(count + 1)
        }
        upstream.reply({ status: 200, contentType: "application/json" })
        const failed = vi.fn()
        await expect(collect(config, upstream.fetcher, failed)).rejects.toThrow(
          /^model_gateway_upstream_failed$/,
        )
        expect(failed).not.toHaveBeenCalled()
      })
    },
  )

  it("propagates actual fetch status and success through the gateway without exposing state", async () => {
    await fixture(async (upstream) => {
      const safeFetch = vi.spyOn(providerNetwork, "providerFetch").mockReturnValue(upstream.fetcher)
      try {
        await gatewayFixture({ ...snapshot, modelApi: "google-generative-ai" }, async (gateway) => {
          expect((await send(gateway)).status).toBe(502)
          expect(gateway.retryableFailure).toBe(true)
          upstream.reply({ status: 401 })
          expect((await send(gateway)).status).toBe(502)
          expect(gateway.retryableFailure).toBe(false)
          upstream.reply({ status: 503 })
          await send(gateway)
          expect(gateway.retryableFailure).toBe(true)
          upstream.reply({ status: 200, body: googleDone })
          const result = await send(gateway)
          expect(result.status).toBe(200)
          expect(result.body).toContain("data: [DONE]")
          expect(result.body).not.toMatch(/fixture-key|retryable|transient/)
          expect(gateway.retryableFailure).toBe(false)
          expect(upstream.count()).toBe(4)
        })
      } finally {
        safeFetch.mockRestore()
      }
    })
  })

  it("classifies actual fetch connection resets and stream resets", async () => {
    await fixture(async (upstream) => {
      const config = { ...snapshot, modelApi: "google-generative-ai" as const }
      for (const reply of ["reset", "truncate"] as const) {
        upstream.reply(reply)
        const failed = vi.fn()
        await expect(collect(config, upstream.fetcher, failed)).rejects.toThrow(
          /^model_gateway_upstream_failed$/,
        )
        expect(failed).toHaveBeenCalledTimes(1)
      }
      expect(upstream.count()).toBe(2)
    })
  })

  it("bounds request/response bodies and rejects malformed output without transient evidence", async () => {
    await fixture(async (upstream) => {
      const config = { ...snapshot, modelApi: "google-generative-ai" as const }
      const failed = vi.fn()
      await expect(
        collect(config, upstream.fetcher, failed, undefined, {
          ...request,
          messages: [{ role: "user", content: "x".repeat(1024 * 1024) }],
        }),
      ).rejects.toThrow(/^model_gateway_upstream_failed$/)
      expect(upstream.count()).toBe(0)
      upstream.reply({ status: 200, body: `: ${"x".repeat(4 * 1024 * 1024)}\n\n` })
      await expect(collect(config, upstream.fetcher, failed)).rejects.toThrow(
        /^model_gateway_upstream_failed$/,
      )
      upstream.reply({ status: 200, body: 'data: {"error":{"code":503}}\n\n' })
      await expect(collect(config, upstream.fetcher, failed)).rejects.toThrow(
        /^model_gateway_upstream_failed$/,
      )
      expect(failed).not.toHaveBeenCalled()
      expect(upstream.count()).toBe(2)
    })
  })

  it("does not classify ordinary cancellation, even with a transient-looking abort reason", async () => {
    await fixture(async (upstream) => {
      const config = { ...snapshot, modelApi: "google-generative-ai" as const }
      const controller = new AbortController()
      const failed = vi.fn()
      upstream.reply("hang")
      const received = upstream.received()
      const rejected = expect(
        collect(config, upstream.fetcher, failed, controller.signal),
      ).rejects.toThrow(/^model_gateway_upstream_failed$/)
      await received
      controller.abort(Object.assign(new Error("cancelled"), { code: "ECONNRESET" }))
      await rejected
      expect(failed).not.toHaveBeenCalled()
      await expect(collect(config, upstream.fetcher, failed, controller.signal)).rejects.toThrow(
        /^model_gateway_upstream_failed$/,
      )
      expect(upstream.count()).toBe(1)
      expect(failed).not.toHaveBeenCalled()
    })
  })

  it("records the gateway-owned 60-second deadline without SDK retries", async () => {
    await fixture(async (upstream) => {
      upstream.reply("hang")
      const safeFetch = vi.spyOn(providerNetwork, "providerFetch").mockReturnValue(upstream.fetcher)
      const timers = vi.spyOn(globalThis, "setTimeout")
      try {
        await gatewayFixture({ ...snapshot, modelApi: "google-generative-ai" }, async (gateway) => {
          const received = upstream.received()
          const pending = send(gateway)
          await received
          const expire = timers.mock.calls.find(([, delay]) => delay === 60_000)?.[0]
          if (typeof expire !== "function") throw new Error("fixture_timeout_missing")
          expire()
          expect((await pending).status).toBe(502)
          expect(gateway.retryableFailure).toBe(true)
          expect(upstream.count()).toBe(1)
        })
      } finally {
        timers.mockRestore()
        safeFetch.mockRestore()
      }
    })
  })

  it("records its owned 60-second timeout, not caller cancellation", async () => {
    await fixture(async (upstream) => {
      const timeout = new AbortController()
      const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal)
      const failed = vi.fn()
      try {
        upstream.reply("hang")
        const received = upstream.received()
        const rejected = expect(
          collect({ ...snapshot, modelApi: "google-generative-ai" }, upstream.fetcher, failed),
        ).rejects.toThrow(/^model_gateway_upstream_failed$/)
        await received
        timeout.abort()
        await rejected
        expect(deadline).toHaveBeenCalledWith(60_000)
        expect(failed).toHaveBeenCalledTimes(1)
      } finally {
        deadline.mockRestore()
      }
    })
  })

  it("does not dispatch missing credentials or unsafe provider destinations", async () => {
    const failed = vi.fn()
    const fetcher = vi.fn() as unknown as typeof fetch
    await expect(collect({ ...snapshot, modelKey: "" }, fetcher, failed)).rejects.toThrow(
      /^model_gateway_upstream_failed$/,
    )
    expect(fetcher).not.toHaveBeenCalled()
    await expect(
      (async () => {
        for await (const _chunk of piChatStream(
          { ...snapshot, modelUrl: "https://127.0.0.1/v1" },
          request,
          new AbortController().signal,
          undefined,
          undefined,
          failed,
        )) {
          throw new Error("unexpected_output")
        }
      })(),
    ).rejects.toThrow(/^model_gateway_upstream_failed$/)
    expect(failed).not.toHaveBeenCalled()
  })

  it("uses exact transport codes with bounded causes, never message or status guesses", async () => {
    for (const [error, retryable] of [
      [Object.assign(new Error("transport"), { code: "ECONNRESET" }), true],
      [new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }), true],
      [{ cause: { cause: { code: "EAI_AGAIN" } } }, true],
      [{ code: "ETIMEDOUT" }, true],
      [{ code: "UND_ERR_HEADERS_TIMEOUT" }, true],
      [{ code: "ENOTFOUND" }, false],
      [{ status: 503 }, false],
      [new Error("ECONNRESET timeout 503 fixture-key"), false],
      [new Error("provider_address_not_public"), false],
      [new Error("provider_origin_changed"), false],
    ] as const) {
      const failed = vi.fn()
      const fetcher = vi.fn(async () => {
        throw error
      }) as unknown as typeof fetch
      await expect(
        collect({ ...snapshot, modelApi: "google-generative-ai" }, fetcher, failed),
      ).rejects.toThrow(/^model_gateway_upstream_failed$/)
      expect(failed).toHaveBeenCalledTimes(retryable ? 1 : 0)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
    const cycle: { cause?: unknown } = {}
    cycle.cause = cycle
    let deep: unknown = { code: "ECONNRESET" }
    for (let index = 0; index < 8; index++) deep = { cause: deep }
    for (const error of [cycle, deep]) {
      const failed = vi.fn()
      await expect(
        collect(
          snapshot,
          (async () => {
            throw error
          }) as typeof fetch,
          failed,
        ),
      ).rejects.toThrow(/^model_gateway_upstream_failed$/)
      expect(failed).not.toHaveBeenCalled()
    }
  })
})
