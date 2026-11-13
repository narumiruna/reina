import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import * as oidc from "openid-client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { SettingsStore } from "../src/settings/store.js"
import { Auth, type AuthOptions } from "../src/web/auth.js"

const transport = vi.hoisted(() => ({ fetch: vi.fn<oidc.CustomFetch>() }))

// Only the transport is replaced. Discovery, PKCE, claims, and signature checks use
// the actual openid-client implementation. No request can leave this fixture.
vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>()
  return {
    ...actual,
    discovery: vi.fn((...args: Parameters<typeof actual.discovery>) =>
      actual.discovery(args[0], args[1], args[2], args[3], {
        ...args[4],
        [actual.customFetch]: transport.fetch,
      }),
    ),
  }
})

const origin = "https://reina.example"
const issuer = "https://pocket.example"
const clientId = "fixture-client"
const clientSecret = "fixture-secret-not-a-credential"
const sessionCookie = "__Host-reina-session"
const loginCookie = "__Host-reina-login"
const invalidGroups: [string, unknown][] = [
  ["missing", undefined],
  ["null", null],
  ["string", "reina-admins"],
  ["object", { name: "reina-admins" }],
  ["object name", [{ name: "reina-admins" }]],
  ["object friendlyName", [{ friendlyName: "reina-admins" }]],
  ["object id", [{ id: "reina-admins" }]],
  ["mixed string and object", ["reina-admins", { name: "readers" }]],
  ["mixed string and number", ["reina-admins", 1]],
  ["mixed string and null", ["reina-admins", null]],
  ["nested array", ["reina-admins", ["readers"]]],
  ["empty array", []],
  ["empty name", ["reina-admins", ""]],
  ["leading whitespace", ["reina-admins", " readers"]],
  ["trailing whitespace", ["reina-admins", "readers "]],
  ["surrounding whitespace on allowed name", [" reina-admins "]],
  ["non-ASCII surrounding whitespace", ["reina-admins", "\u00a0readers\u00a0"]],
  ["NUL control", ["reina-admins", "read\u0000ers"]],
  ["newline control", ["reina-admins", "read\ners"]],
  ["tab control", ["reina-admins", "read\ters"]],
  ["DEL control", ["reina-admins", "read\u007fers"]],
  ["C1 control", ["reina-admins", "read\u0085ers"]],
  ["oversized name", ["reina-admins", "a".repeat(257)]],
  [
    "oversized array",
    ["reina-admins", ...Array.from({ length: 256 }, (_, index) => `group-${index}`)],
  ],
]
const keys = generateKeyPairSync("rsa", { modulusLength: 2_048 })
const wrongKeys = generateKeyPairSync("rsa", { modulusLength: 2_048 })
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256" }
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  jwks_uri: `${issuer}/jwks`,
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  token_endpoint_auth_methods_supported: ["client_secret_post"],
  code_challenge_methods_supported: ["S256"],
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url")
}

class MockStore {
  readonly sessions = new Map<
    string,
    { subject: string; name: string; csrfToken: string; groups: string[]; expiresAt: number }
  >()
  readonly deleted: string[] = []

  createSession(subject: string, name: string, groups: string[]) {
    const token = randomBytes(32).toString("base64url")
    const csrfToken = randomBytes(32).toString("base64url")
    this.sessions.set(digest(token), {
      subject,
      name,
      csrfToken,
      groups: [...groups],
      expiresAt: Date.now() + 8 * 60 * 60 * 1_000,
    })
    return { token, csrfToken }
  }

  session(token: string) {
    const session = this.sessions.get(digest(token))
    if (!session) return undefined
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(digest(token))
      return undefined
    }
    const { subject, name, csrfToken, groups } = session
    return { subject, name, csrfToken, groups }
  }

  deleteSession(token: string) {
    this.deleted.push(token)
    this.sessions.delete(digest(token))
  }
}

class ResponseFixture {
  statusCode = 200
  readonly headers = new Map<string, string | string[]>()
  body = ""
  getHeader(name: string) {
    return this.headers.get(name.toLowerCase())
  }
  setHeader(name: string, value: string | string[]) {
    this.headers.set(name.toLowerCase(), value)
  }
  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
  }
  end(body = "") {
    this.body = body
  }
  get location(): string {
    return String(this.getHeader("location"))
  }
  cookie(name: string): string | undefined {
    const values = this.getHeader("set-cookie")
    const list = Array.isArray(values) ? values : values ? [values] : []
    return list.find((value) => value.startsWith(`${name}=`))?.split(";")[0]
  }
}

function request(headers: IncomingHttpHeaders = {}, method = "GET"): IncomingMessage {
  return { headers, method } as IncomingMessage
}

let store: MockStore
let auth: Auth
let options: AuthOptions
let codes: Map<string, { nonce: string; challenge: string }>
let claims: Record<string, unknown>
let invalidSignature: boolean
let omitIdToken: boolean
let discoveryFailures: number
let exchanges: number
let discoveries: number
let now: number

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  now = Date.now()
  vi.spyOn(Date, "now").mockImplementation(() => now)
  vi.mocked(oidc.discovery).mockClear()
  transport.fetch.mockReset()
  codes = new Map()
  claims = {}
  invalidSignature = false
  omitIdToken = false
  discoveryFailures = 0
  discoveries = 0
  exchanges = 0
  store = new MockStore()
  options = { origin, issuer, clientId, clientSecret, allowedGroups: ["reina-admins"] }
  auth = new Auth(store as unknown as SettingsStore, options)
  transport.fetch.mockImplementation(async (input, init) => {
    const url = new URL(String(input))
    if (url.href === `${issuer}/.well-known/openid-configuration`) {
      discoveries++
      if (discoveryFailures-- > 0) throw new Error("fixture_discovery_failure_secret")
      return json(metadata)
    }
    if (url.href === `${issuer}/jwks`) return json({ keys: [jwk] })
    if (url.href === `${issuer}/token`) {
      exchanges++
      const body = new URLSearchParams(String(init?.body))
      expect(init?.method).toBe("POST")
      expect(body.get("client_id")).toBe(clientId)
      expect(body.get("client_secret")).toBe(clientSecret)
      expect(body.get("redirect_uri")).toBe(`${origin}/auth/callback`)
      expect(body.get("grant_type")).toBe("authorization_code")
      const code = body.get("code") ?? ""
      const authorization = codes.get(code)
      codes.delete(code)
      if (!authorization || digest(body.get("code_verifier") ?? "") !== authorization.challenge) {
        return json({ error: "invalid_grant" }, 400)
      }
      const issuedAt = Math.floor(Date.now() / 1_000)
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture" })).toString(
        "base64url",
      )
      const payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          aud: clientId,
          sub: "fixture-subject",
          name: "Fixture User",
          groups: ["reina-admins"],
          nonce: authorization.nonce,
          iat: issuedAt,
          exp: issuedAt + 300,
          ...claims,
        }),
      ).toString("base64url")
      const signed = `${header}.${payload}`
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(signed),
        invalidSignature ? wrongKeys.privateKey : keys.privateKey,
      ).toString("base64url")
      return json({
        access_token: "fixture-access-token-never-stored",
        token_type: "Bearer",
        expires_in: 300,
        ...(omitIdToken ? {} : { id_token: `${signed}.${signature}` }),
      })
    }
    throw new Error(`unexpected_fixture_request: ${url.origin}${url.pathname}`)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function route(
  path: string,
  headers: IncomingHttpHeaders = {},
  method = "GET",
): Promise<ResponseFixture> {
  const response = new ResponseFixture()
  const handled = await auth.handle(
    request(headers, method),
    response as unknown as ServerResponse,
    new URL(path, origin),
  )
  expect(handled).toBe(true)
  expect(response.getHeader("cache-control")).toBe("no-store")
  expect(response.body).not.toContain(clientSecret)
  expect(response.body).not.toContain("fixture-access-token")
  return response
}

async function begin(headers: IncomingHttpHeaders = {}) {
  const response = await route("/auth/login?returnTo=https://evil.example", headers)
  expect(response.statusCode).toBe(303)
  const target = new URL(response.location)
  expect(target.origin).toBe(issuer)
  expect(target.searchParams.get("redirect_uri")).toBe(`${origin}/auth/callback`)
  expect(target.searchParams.get("response_type")).toBe("code")
  expect(target.searchParams.get("scope")).toBe("openid profile groups")
  expect(target.searchParams.get("code_challenge_method")).toBe("S256")
  const browserCookie = response.cookie(loginCookie)
  expect(browserCookie).toBeDefined()
  return { response, target, browserCookie: browserCookie as string }
}

function authorize(target: URL): string {
  const code = randomBytes(24).toString("base64url")
  codes.set(code, {
    nonce: target.searchParams.get("nonce") ?? "",
    challenge: target.searchParams.get("code_challenge") ?? "",
  })
  const callback = new URL("/auth/callback", origin)
  callback.searchParams.set("code", code)
  callback.searchParams.set("state", target.searchParams.get("state") ?? "")
  return callback.href
}

async function login() {
  const { target, browserCookie } = await begin()
  const response = await route(authorize(target), { cookie: browserCookie })
  expect(response.location).toBe("/")
  const cookie = response.cookie(sessionCookie) as string
  expect(cookie).toBeDefined()
  const session = auth.session(request({ cookie }))
  expect(session).toMatchObject({
    subject: claims.sub ?? "fixture-subject",
    name: claims.name ?? "Fixture User",
    groups: claims.groups ?? ["reina-admins"],
  })
  return { response, cookie, session }
}

describe("Pocket ID authentication", () => {
  test("uses signed OIDC code flow with PKCE, state, nonce, and host-only cookies", async () => {
    const { response, cookie, session } = await login()
    expect(session?.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(store.sessions.size).toBe(1)
    expect(store.sessions.has(cookie.split("=")[1])).toBe(false)
    expect(response.body).toBe("")
    const cookies = response.getHeader("set-cookie") as string[]
    expect(cookies).toContain(`${loginCookie}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`)
    expect(cookies.find((value) => value.startsWith(`${sessionCookie}=`))).toMatch(
      /; Path=\/; Max-Age=28800; Secure; HttpOnly; SameSite=Lax$/,
    )
    expect(cookies.join(";")).not.toMatch(/Domain=|access_token|id_token|refresh_token/i)
    expect(exchanges).toBe(1)
    expect(discoveries).toBe(1)
    expect(transport.fetch.mock.calls.some(([url]) => String(url) === `${issuer}/jwks`)).toBe(true)
    expect(vi.mocked(oidc.discovery).mock.calls[0][4]).toMatchObject({ timeout: 10 })
  })

  test("login cookie is secure, short-lived, and contains no state or nonce", async () => {
    const { response, target, browserCookie } = await begin()
    expect(response.getHeader("set-cookie")).toEqual([
      `${browserCookie}; Path=/; Max-Age=300; Secure; HttpOnly; SameSite=Lax`,
    ])
    expect(browserCookie).not.toContain(target.searchParams.get("state"))
    expect(browserCookie).not.toContain(target.searchParams.get("nonce"))
  })

  test.each(["issuer", "clientId", "clientSecret", "allowedGroups"] as const)(
    "locks login and callback when %s is empty without discovery",
    async (field) => {
      if (field === "allowedGroups") options.allowedGroups = []
      else options[field] = ""
      for (const path of ["/auth/login", "/auth/callback?code=anything&state=anything"]) {
        expect((await route(path)).location).toBe("/login?error=auth_not_configured")
      }
      const local = store.createSession("fixture-subject", "Previously signed in", ["reina-admins"])
      expect(auth.session(request({ cookie: `${sessionCookie}=${local.token}` }))).toBeUndefined()
      expect(oidc.discovery).not.toHaveBeenCalled()
      expect(transport.fetch).not.toHaveBeenCalled()
    },
  )

  test("rejects missing browser binding without consuming the legitimate browser transaction", async () => {
    const { target, browserCookie } = await begin()
    const callback = authorize(target)
    expect((await route(callback)).location).toBe("/login?error=login_failed")
    expect(exchanges).toBe(0)
    expect((await route(callback, { cookie: browserCookie })).location).toBe("/")
  })

  test("rejects binding from a different browser and consumes that browser's transaction", async () => {
    const first = await begin()
    const second = await begin()
    const callback = authorize(first.target)
    expect((await route(callback, { cookie: second.browserCookie })).location).toBe(
      "/login?error=login_failed",
    )
    expect(exchanges).toBe(0)
    expect((await route(authorize(second.target), { cookie: second.browserCookie })).location).toBe(
      "/login?error=login_failed",
    )
    expect((await route(callback, { cookie: first.browserCookie })).location).toBe("/")
  })

  test("consumes invalid-state callbacks before exchange and does not permit retry", async () => {
    const { target, browserCookie } = await begin()
    const callback = authorize(target)
    const invalid = new URL(callback)
    invalid.searchParams.set("state", "wrong-state")
    const failure = await route(invalid.href, { cookie: browserCookie })
    expect(failure.location).toBe("/login?error=login_failed")
    expect(failure.cookie(loginCookie)).toBe(`${loginCookie}=`)
    expect((await route(callback, { cookie: browserCookie })).location).toBe(
      "/login?error=login_failed",
    )
    expect(exchanges).toBe(0)
  })

  test("rejects callback replay, including concurrent callbacks", async () => {
    const { target, browserCookie } = await begin()
    const callback = authorize(target)
    const responses = await Promise.all([
      route(callback, { cookie: browserCookie }),
      route(callback, { cookie: browserCookie }),
    ])
    expect(responses.map((response) => response.location).sort()).toEqual([
      "/",
      "/login?error=login_failed",
    ])
    expect((await route(callback, { cookie: browserCookie })).location).toBe(
      "/login?error=login_failed",
    )
    expect(exchanges).toBe(1)
  })

  test("expires browser transactions after exactly five minutes", async () => {
    const { target, browserCookie } = await begin()
    now += 5 * 60 * 1_000
    expect((await route(authorize(target), { cookie: browserCookie })).location).toBe(
      "/login?error=login_failed",
    )
    expect(exchanges).toBe(0)
    await begin()
  })

  test("new login in the same browser invalidates its previous transaction", async () => {
    const first = await begin()
    const second = await begin({ cookie: first.browserCookie })
    expect((await route(authorize(first.target), { cookie: first.browserCookie })).location).toBe(
      "/login?error=login_failed",
    )
    expect((await route(authorize(second.target), { cookie: second.browserCookie })).location).toBe(
      "/",
    )
  })

  test.each(["unlisted-subject", "reina-admins"])(
    "uses subject %s only as identity when a signed group is allowed",
    async (subject) => {
      claims = { sub: subject }
      const { session } = await login()
      expect(session?.subject).toBe(subject)
      expect([...store.sessions.values()][0].subject).toBe(subject)
    },
  )

  test("accepts any exact intersection and saves all signed group names", async () => {
    options.allowedGroups = ["another-admin-group", "reina-admins"]
    claims = { groups: ["readers", "reina-admins", "operators"] }
    const { session } = await login()
    expect(session?.groups).toEqual(claims.groups)
    expect([...store.sessions.values()][0].groups).toEqual(claims.groups)
  })

  test("accepts group names and group counts at their limits", async () => {
    const longestName = "a".repeat(256)
    options.allowedGroups = [longestName]
    claims = {
      groups: [...Array.from({ length: 255 }, (_, index) => `group-${index}`), longestName],
    }
    await login()
  })

  test("accepts full group names with internal spaces without using display names", async () => {
    options.allowedGroups = ["Reina Administrators"]
    claims = { groups: ["Reina Administrators"] }
    await login()
  })

  test.each([
    ["nonmatching", ["readers"]],
    ["missing", undefined],
  ])("matching sub, email, and name do not rescue %s groups", async (_name, groups) => {
    claims = { sub: "reina-admins", email: "reina-admins", name: "reina-admins", groups }
    const { target, browserCookie } = await begin()
    const callback = authorize(target)
    const response = await route(callback, { cookie: browserCookie })
    expect(response.location).toBe("/login?error=access_denied")
    expect(response.cookie(sessionCookie)).toBeUndefined()
    expect(store.sessions.size).toBe(0)
    expect((await route(callback, { cookie: browserCookie })).location).toBe(
      "/login?error=login_failed",
    )
  })

  test.each(["REINA-ADMINS", "reina-admin", "reina-admins-extra", "prefix-reina-admins"])(
    "rejects non-exact group name %s",
    async (group) => {
      claims = { groups: [group] }
      const { target, browserCookie } = await begin()
      const response = await route(authorize(target), { cookie: browserCookie })
      expect(response.location).toBe("/login?error=access_denied")
      expect(response.cookie(sessionCookie)).toBeUndefined()
      expect(store.sessions.size).toBe(0)
    },
  )

  test.each(invalidGroups)("denies signed tokens with %s groups", async (_name, groups) => {
    claims = { groups }
    const { target, browserCookie } = await begin()
    const response = await route(authorize(target), { cookie: browserCookie })
    expect(response.location).toBe("/login?error=access_denied")
    expect(response.cookie(sessionCookie)).toBeUndefined()
    expect(store.sessions.size).toBe(0)
    expect(exchanges).toBe(1)
  })

  test.each([
    ["nonce", { nonce: "wrong-nonce" }],
    ["missing nonce", { nonce: undefined }],
    ["issuer", { iss: "https://other.example" }],
    ["audience", { aud: "other-client" }],
    ["expired token", { exp: 1 }],
    ["missing subject", { sub: undefined }],
  ])("rejects invalid ID token %s", async (_name, overrides) => {
    claims = overrides as Record<string, unknown>
    const { target, browserCookie } = await begin()
    const response = await route(authorize(target), { cookie: browserCookie })
    expect(response.location).toBe("/login?error=login_failed")
    expect(response.cookie(sessionCookie)).toBeUndefined()
    expect(store.sessions.size).toBe(0)
  })

  test.each(["forged signature with an allowed admin group", "missing token"])(
    "rejects invalid ID token %s",
    async (failure) => {
      invalidSignature = failure === "forged signature with an allowed admin group"
      omitIdToken = failure === "missing token"
      const { target, browserCookie } = await begin()
      const callback = authorize(target)
      expect((await route(callback, { cookie: browserCookie })).location).toBe(
        "/login?error=login_failed",
      )
      expect((await route(callback, { cookie: browserCookie })).location).toBe(
        "/login?error=login_failed",
      )
      expect(store.sessions.size).toBe(0)
      expect(exchanges).toBe(1)
    },
  )

  test("rejects IdP errors without reflecting their description", async () => {
    const { target, browserCookie } = await begin()
    const callback = new URL("/auth/callback", origin)
    callback.searchParams.set("state", target.searchParams.get("state") ?? "")
    callback.searchParams.set("error", "access_denied")
    callback.searchParams.set("error_description", "sensitive-provider-error")
    const response = await route(callback.href, { cookie: browserCookie })
    expect(response.location).toBe("/login?error=login_failed")
    expect(response.body).toBe("")
    expect(exchanges).toBe(0)
  })

  test("rechecks current exact group policy on every session lookup", async () => {
    claims = { groups: ["reina-admins", "operators"] }
    const { cookie } = await login()
    const req = request({ cookie })
    options.allowedGroups = ["REINA-ADMINS", "reina-admins-extra", "fixture-subject"]
    expect(auth.session(req)).toBeUndefined()
    options.allowedGroups = ["operators"]
    expect(auth.session(req)?.subject).toBe("fixture-subject")
    options.allowedGroups = []
    expect(auth.session(req)).toBeUndefined()
    options.allowedGroups = ["reina-admins"]
    expect(auth.session(req)?.groups).toEqual(["reina-admins", "operators"])
  })

  test.each(invalidGroups)("rejects cached sessions with %s groups", (_name, groups) => {
    const local = store.createSession("reina-admins", "reina-admins", ["reina-admins"])
    const malformed = {
      subject: "reina-admins",
      name: "reina-admins",
      csrfToken: local.csrfToken,
      ...(groups === undefined ? {} : { groups }),
    }
    vi.spyOn(store, "session").mockReturnValue(malformed as ReturnType<MockStore["session"]>)
    expect(auth.session(request({ cookie: `${sessionCookie}=${local.token}` }))).toBeUndefined()
    expect(transport.fetch).not.toHaveBeenCalled()
  })

  test("does not authorize cached sessions by subject or name", () => {
    const local = store.createSession("reina-admins", "reina-admins", ["readers"])
    expect(auth.session(request({ cookie: `${sessionCookie}=${local.token}` }))).toBeUndefined()
    expect(transport.fetch).not.toHaveBeenCalled()
  })

  test("respects session expiration from the store", async () => {
    const { cookie } = await login()
    now += 8 * 60 * 60 * 1_000
    expect(auth.session(request({ cookie }))).toBeUndefined()
    expect((await route("/auth/logout", { cookie, origin }, "POST")).statusCode).toBe(401)
  })

  test("rotates the previous local session on successful login", async () => {
    const previous = store.createSession("fixture-subject", "Previous User", ["reina-admins"])
    const { target, browserCookie } = await begin()
    const response = await route(authorize(target), {
      cookie: `${browserCookie}; ${sessionCookie}=${previous.token}`,
    })
    expect(response.location).toBe("/")
    expect(store.deleted).toEqual([previous.token])
    expect(store.session(previous.token)).toBeUndefined()
    expect(store.sessions.size).toBe(1)
  })

  test("requires exact Origin and CSRF token for local logout", async () => {
    const { cookie, session } = await login()
    const csrfToken = session?.csrfToken ?? ""
    for (const headers of [
      { cookie },
      { cookie, origin },
      { cookie, origin, "x-csrf-token": "wrong" },
      { cookie, origin, "x-csrf-token": "x".repeat(csrfToken.length) },
      { cookie, origin: `${origin}/`, "x-csrf-token": csrfToken },
      { cookie, origin: "https://evil.example", "x-csrf-token": csrfToken },
      { cookie, "x-forwarded-origin": origin, "x-csrf-token": csrfToken },
      { cookie, origin, "x-csrf-token": [csrfToken, csrfToken] },
    ]) {
      const response = await route("/auth/logout", headers, "POST")
      expect(response.statusCode).toBe(403)
      expect(response.cookie(sessionCookie)).toBeUndefined()
      expect(auth.session(request({ cookie }))).toBeDefined()
    }
    const requestsBefore = transport.fetch.mock.calls.length
    const response = await route(
      "/auth/logout",
      { cookie, origin, "x-csrf-token": csrfToken },
      "POST",
    )
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true })
    expect(response.getHeader("set-cookie")).toEqual([
      `${sessionCookie}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    ])
    expect(auth.session(request({ cookie }))).toBeUndefined()
    expect(transport.fetch.mock.calls.length).toBe(requestsBefore)
  })

  test("rejects duplicate or malformed session and transaction cookies", async () => {
    const { cookie } = await login()
    expect(auth.session(request({ cookie: `${cookie}; ${cookie}` }))).toBeUndefined()
    expect(auth.session(request({ cookie: `${sessionCookie}=%00invalid` }))).toBeUndefined()
    const { target, browserCookie } = await begin()
    expect(
      (await route(authorize(target), { cookie: `${browserCookie}; ${browserCookie}` })).location,
    ).toBe("/login?error=login_failed")
  })

  test("rejects framing and cross-site background login but permits top-level links", async () => {
    for (const headers of [
      { "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate" },
      { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" },
      {
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
      { origin: "https://evil.example" },
    ]) {
      expect((await route("/auth/login", headers)).location).toBe("/login?error=login_failed")
    }
    expect(transport.fetch).not.toHaveBeenCalled()
    await begin({
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "cross-site",
      "sec-fetch-user": "?1",
    })
  })

  test("uses only the configured origin, not forwarded headers", async () => {
    await begin({
      host: "evil.example",
      forwarded: "host=evil.example;proto=http",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
    })
  })

  test("caches discovery and recovers from failure without leaking errors", async () => {
    discoveryFailures = 1
    const response = await route("/auth/login")
    expect(response.location).toBe("/login?error=login_failed")
    expect(response.body).toBe("")
    await begin()
    await begin()
    expect(discoveries).toBe(2)
  })

  test("rate limits without trusting spoofed source IP headers", async () => {
    for (let count = 0; count < 32; count++) await begin()
    expect((await route("/auth/login", { "x-forwarded-for": "203.0.113.99" })).location).toBe(
      "/login?error=login_failed",
    )
    now += 60_000
    await begin()
    expect(discoveries).toBe(1)
  })

  test("caps pending transactions at 128 and cleans up expired transactions", async () => {
    for (let minute = 0; minute < 4; minute++) {
      for (let count = 0; count < 32; count++) await begin()
      now += 60_000
    }
    expect((await route("/auth/login")).location).toBe("/login?error=login_failed")
    now += 60_000
    await begin()
  })

  test.each([
    ["GET", "/auth/logout"],
    ["POST", "/auth/login"],
    ["POST", "/auth/callback"],
    ["GET", "/auth/other"],
    ["GET", "/api/settings"],
  ])("does not handle %s %s", async (method, path) => {
    const response = new ResponseFixture()
    expect(
      await auth.handle(
        request({}, method),
        response as unknown as ServerResponse,
        new URL(path, origin),
      ),
    ).toBe(false)
    expect(response.headers.size).toBe(0)
    expect(transport.fetch).not.toHaveBeenCalled()
  })
})
