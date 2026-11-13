import { runInNewContext } from "node:vm"
import { describe, expect, test, vi } from "vitest"
import { GATEWAY_PROBE } from "../src/agent/sandbox.js"

function probe() {
  const exit = vi.fn()
  const end = vi.fn()
  const requestError = vi.fn<(event: string, callback: (error: Error) => void) => void>()
  let respond: (response: unknown) => void = () => {}
  const request = vi.fn(
    (_url: string, _options: unknown, response: (response: unknown) => void) => {
      respond = response
      return { on: requestError, end }
    },
  )
  runInNewContext(
    GATEWAY_PROBE.replace("import http from 'node:http';", ""),
    {
      http: { request },
      process: { exit },
    },
    { timeout: 1000 },
  )
  return { exit, end, requestError, request, respond }
}

describe("unauthorized socket readiness probe", () => {
  test("sends no body, capability, or provider credentials", () => {
    const value = probe()
    expect(value.request).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:3210/v1/chat/completions",
      { method: "POST", headers: { "content-length": "0" } },
      expect.any(Function),
    )
    expect(value.end).toHaveBeenCalledExactlyOnceWith()
  })

  test.each([200, 400, 401, 403, 502])(
    "accepts only 401, not %s as an alternative",
    (statusCode) => {
      const value = probe()
      const resume = vi.fn()
      const on = vi.fn((_event: string, callback: () => void) => callback())
      value.respond({ statusCode, resume, on })
      expect(resume).toHaveBeenCalledExactlyOnceWith()
      expect(value.exit).toHaveBeenCalledExactlyOnceWith(statusCode === 401 ? 0 : 1)
    },
  )

  test("a transport error fails readiness instead of skipping the check", () => {
    const value = probe()
    const [event, callback] = value.requestError.mock.calls[0]
    expect(event).toBe("error")
    callback(new Error("fixture transport failure"))
    expect(value.exit).toHaveBeenCalledExactlyOnceWith(1)
  })
})
