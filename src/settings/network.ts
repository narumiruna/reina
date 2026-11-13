import { lookup } from "node:dns"
import { isIP, type LookupFunction } from "node:net"
import ipaddr from "ipaddr.js"
import { Agent, fetch as request } from "undici"
import { endpoint } from "./schema.js"

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast"
  } catch {
    return false
  }
}

/** Validate every resolved address at connection time, not just when saving settings. */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, "", 0)
    if (!addresses.length || addresses.some((value) => !isPublicAddress(value.address)))
      return callback(new Error("provider_address_not_public"), "", 0)
    if (options.all) {
      callback(null, addresses)
    } else {
      const family = options.family
      const selected = addresses.find((value) => !family || value.family === family)
      if (!selected) return callback(new Error("provider_address_unavailable"), "", 0)
      callback(null, selected.address, selected.family)
    }
  })
}

export function validateProviderUrl(value: string): void {
  if (!endpoint(value)) throw new Error("invalid_provider_url")
  const host = new URL(value).hostname.replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && !isPublicAddress(host)))
    throw new Error("provider_address_not_public")
}

const dispatcher = new Agent({
  connect: { lookup: publicLookup },
  headersTimeout: 30_000,
  bodyTimeout: 60_000,
})

/** pi-ai receives this fetch instead of ambient fetch or proxy credentials. */
export function providerFetch(baseUrl: string): typeof globalThis.fetch {
  validateProviderUrl(baseUrl)
  const origin = new URL(baseUrl).origin
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    )
    const destination = new URL(url)
    destination.search = ""
    validateProviderUrl(destination.href)
    if (url.origin !== origin) throw new Error("provider_origin_changed")
    const outgoing = new Request(input, init)
    return (await request(url, {
      method: outgoing.method,
      headers: Object.fromEntries(outgoing.headers),
      body: outgoing.body,
      signal: outgoing.signal,
      duplex: "half",
      redirect: "error",
      dispatcher,
    } as Parameters<typeof request>[1])) as unknown as Response
  }
}
