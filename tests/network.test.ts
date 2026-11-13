import { lookup } from "node:dns"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
  agentOptions: undefined as unknown,
}))
vi.mock("node:dns", () => ({ lookup: mocks.lookup }))
vi.mock("undici", () => ({
  Agent: class {
    constructor(options: unknown) {
      mocks.agentOptions = options
    }
  },
  fetch: mocks.request,
}))

import { providerFetch, publicLookup } from "../src/settings/network.js"

beforeEach(() => {
  mocks.lookup.mockReset()
  mocks.request.mockReset()
})
const resolve = (all = false, family = 0) =>
  new Promise<{ address: unknown; family?: number }>((accept, reject) => {
    publicLookup("model.example", { all, family }, (error, address, resolvedFamily) =>
      error ? reject(error) : accept({ address, family: resolvedFamily }),
    )
  })

describe("connection-time DNS boundary", () => {
  it("pins only checked public addresses and installs the lookup in the private agent", async () => {
    mocks.lookup.mockImplementation((_host, _options, callback) =>
      callback(null, [
        { address: "1.1.1.1", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ]),
    )
    await expect(resolve()).resolves.toEqual({ address: "1.1.1.1", family: 4 })
    await expect(resolve(false, 6)).resolves.toEqual({ address: "2606:4700:4700::1111", family: 6 })
    expect(mocks.agentOptions).toEqual(
      expect.objectContaining({ connect: { lookup: publicLookup } }),
    )
    expect(lookup).toHaveBeenCalledWith(
      "model.example",
      { all: true, verbatim: true },
      expect.any(Function),
    )
  })
  it("supports all-address lookup while rejecting mixed public/private DNS answers", async () => {
    const addresses = [{ address: "1.1.1.1", family: 4 }]
    mocks.lookup.mockImplementation((_host, _options, callback) => callback(null, addresses))
    await expect(resolve(true)).resolves.toEqual({ address: addresses, family: undefined })
    for (const address of ["127.0.0.1", "192.168.1.10", "169.254.169.254", "::ffff:127.0.0.1"]) {
      mocks.lookup.mockImplementation((_host, _options, callback) =>
        callback(null, [...addresses, { address, family: 4 }]),
      )
      await expect(resolve()).rejects.toThrow("provider_address_not_public")
    }
  })
  it("rejects empty results, lookup errors and unavailable address families", async () => {
    mocks.lookup.mockImplementation((_host, _options, callback) => callback(null, []))
    await expect(resolve()).rejects.toThrow("provider_address_not_public")
    mocks.lookup.mockImplementation((_host, _options, callback) =>
      callback(new Error("fixture-dns-failure"), []),
    )
    await expect(resolve()).rejects.toThrow("fixture-dns-failure")
    mocks.lookup.mockImplementation((_host, _options, callback) =>
      callback(null, [{ address: "1.1.1.1", family: 4 }]),
    )
    await expect(resolve(false, 6)).rejects.toThrow("provider_address_unavailable")
  })
})

describe("provider fetch", () => {
  it("retains SDK request body/headers and allows protocol-generated query parameters", async () => {
    mocks.request.mockResolvedValue(new Response("ok"))
    const fetcher = providerFetch("https://model.example/v1")
    const req = new Request("https://model.example/v1/messages?beta=true", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "fixture-key" },
      body: '{"messages":[]}',
    })
    await fetcher(req)
    const [url, options] = mocks.request.mock.calls[0]
    expect(url.href).toBe(req.url)
    expect(options).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", "x-api-key": "fixture-key" },
    })
    expect(await new Response(options.body).text()).toBe('{"messages":[]}')
  })
  it("never follows redirects or permits request-controlled destinations", async () => {
    mocks.request.mockResolvedValue(new Response("ok"))
    const fetcher = providerFetch("https://model.example/v1")
    await fetcher("https://model.example/v1/models?alt=sse", { redirect: "follow" })
    expect(mocks.request.mock.calls[0][1].redirect).toBe("error")
    mocks.request.mockClear()
    for (const url of [
      "https://evil.example/v1",
      "https://model.example:444/v1",
      "http://model.example/v1",
      "https://user:pass@model.example/v1",
      "https://model.example/v1#fragment",
      "https://127.0.0.1/v1",
    ])
      await expect(fetcher(url)).rejects.toThrow()
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
