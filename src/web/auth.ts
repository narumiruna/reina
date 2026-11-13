import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import * as oidc from "openid-client"
import type { Session, SettingsStore } from "../settings/store.js"
import { groupNamesSchema } from "./groups.js"

export interface AuthOptions {
  origin: string
  issuer: string
  clientId: string
  clientSecret: string
  allowedGroups: string[]
}

interface Transaction {
  verifier: string
  state: string
  nonce: string
  expiresAt: number
}

const sessionCookie = "__Host-reina-session"
const loginCookie = "__Host-reina-login"
const transactionLifetime = 5 * 60 * 1_000
const maxPending = 128
const loginWindow = 60 * 1_000
const maxStarts = 32

// Reject ambiguous cookies. Tokens are opaque base64url values, not encoded text.
function cookie(req: IncomingMessage, name: string): string | undefined {
  const matches = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
  if (matches.length !== 1) return undefined
  const value = matches[0].slice(name.length + 1)
  return /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : undefined
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function setCookie(res: ServerResponse, name: string, value: string, maxAge: number): void {
  const previous = res.getHeader("set-cookie")
  const cookies = Array.isArray(previous) ? previous : previous ? [String(previous)] : []
  res.setHeader("set-cookie", [
    ...cookies,
    `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`,
  ])
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location })
  res.end()
}

export class Auth {
  private readonly pending = new Map<string, Transaction>()
  private configuration?: Promise<oidc.Configuration>
  private windowStart = 0
  private starts = 0

  constructor(
    private readonly store: SettingsStore,
    private readonly options: AuthOptions,
  ) {}

  private configured(): boolean {
    return Boolean(
      this.options.issuer &&
        this.options.clientId &&
        this.options.clientSecret &&
        this.options.allowedGroups.some((group) => group.length > 0),
    )
  }

  private authorizedGroups(value: unknown): string[] | undefined {
    const result = groupNamesSchema.safeParse(value)
    return result.success && result.data.some((group) => this.options.allowedGroups.includes(group))
      ? result.data
      : undefined
  }

  session(req: IncomingMessage): Session | undefined {
    if (!this.configured()) return undefined
    const token = cookie(req, sessionCookie)
    const session = token ? this.store.session(token) : undefined
    return session && this.authorizedGroups(session.groups) ? session : undefined
  }

  ownerActive(owner: string): boolean {
    if (!this.configured()) return false
    const session = this.store.sessionForOwner(owner)
    return Boolean(session && this.authorizedGroups(session.groups))
  }

  checkMutation(req: IncomingMessage, session: Session | undefined): boolean {
    if (!session || req.headers.origin !== this.options.origin) return false
    const csrf = req.headers["x-csrf-token"]
    if (typeof csrf !== "string" || csrf.length === 0 || csrf.length > 256) return false
    const received = Buffer.from(csrf)
    const expected = Buffer.from(session.csrfToken)
    return received.length === expected.length && timingSafeEqual(received, expected)
  }

  private discover(): Promise<oidc.Configuration> {
    if (!this.configuration) {
      this.configuration = oidc
        .discovery(
          new URL(this.options.issuer),
          this.options.clientId,
          this.options.clientSecret,
          oidc.ClientSecretPost(this.options.clientSecret),
          { timeout: 10, execute: [oidc.enableNonRepudiationChecks] },
        )
        .catch((error: unknown) => {
          this.configuration = undefined
          throw error
        })
    }
    return this.configuration
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [key, transaction] of this.pending) {
      if (transaction.expiresAt <= now) this.pending.delete(key)
    }
  }

  private consume(req: IncomingMessage): Transaction | undefined {
    const browser = cookie(req, loginCookie)
    if (!browser) return undefined
    const key = hash(browser)
    const transaction = this.pending.get(key)
    this.pending.delete(key)
    return transaction && transaction.expiresAt > Date.now() ? transaction : undefined
  }

  private canStart(req: IncomingMessage): boolean {
    // Permit top-level links, including links from other sites, but not frames or fetches.
    const { headers } = req
    if (headers.origin && headers.origin !== this.options.origin) return false
    if (headers["sec-fetch-dest"] && headers["sec-fetch-dest"] !== "document") return false
    if (headers["sec-fetch-mode"] && headers["sec-fetch-mode"] !== "navigate") return false
    if (headers["sec-fetch-site"] === "cross-site" && headers["sec-fetch-user"] !== "?1") {
      return false
    }
    const now = Date.now()
    if (now - this.windowStart >= loginWindow) {
      this.windowStart = now
      this.starts = 0
    }
    // A process-wide budget does not trust source IP or forwarded headers.
    if (this.starts >= maxStarts || this.pending.size >= maxPending) return false
    this.starts++
    return true
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.configured()) {
      redirect(res, "/login?error=auth_not_configured")
      return
    }
    if (!this.canStart(req)) {
      redirect(res, "/login?error=login_failed")
      return
    }
    this.consume(req)
    const browser = randomBytes(32).toString("base64url")
    const key = hash(browser)
    const transaction: Transaction = {
      verifier: oidc.randomPKCECodeVerifier(),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      expiresAt: Date.now() + transactionLifetime,
    }
    // Reserve capacity before discovery, including while discovery is in flight.
    this.pending.set(key, transaction)
    try {
      const config = await this.discover()
      const challenge = await oidc.calculatePKCECodeChallenge(transaction.verifier)
      if (transaction.expiresAt <= Date.now()) throw new Error("expired_transaction")
      const target = oidc.buildAuthorizationUrl(config, {
        redirect_uri: new URL("/auth/callback", this.options.origin).href,
        scope: "openid profile groups",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: transaction.state,
        nonce: transaction.nonce,
      })
      setCookie(res, loginCookie, browser, transactionLifetime / 1_000)
      redirect(res, target.href)
    } catch {
      this.pending.delete(key)
      setCookie(res, loginCookie, "", 0)
      redirect(res, "/login?error=login_failed")
    }
  }

  private async callback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Consume before validation or any await. A failed callback cannot reuse the transaction.
    const transaction = this.consume(req)
    setCookie(res, loginCookie, "", 0)
    if (!this.configured()) {
      redirect(res, "/login?error=auth_not_configured")
      return
    }
    if (!transaction) {
      redirect(res, "/login?error=login_failed")
      return
    }
    try {
      const callback = new URL("/auth/callback", this.options.origin)
      callback.search = url.search
      const tokens = await oidc.authorizationCodeGrant(await this.discover(), callback, {
        pkceCodeVerifier: transaction.verifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      })
      const claims = tokens.claims()
      const groups = this.authorizedGroups(claims?.groups)
      if (!claims || !groups) {
        redirect(res, "/login?error=access_denied")
        return
      }
      const name = typeof claims.name === "string" ? claims.name : claims.sub
      const session = this.store.createSession(claims.sub, name, groups)
      const previous = cookie(req, sessionCookie)
      if (previous) this.store.deleteSession(previous)
      setCookie(res, sessionCookie, session.token, 8 * 60 * 60)
      redirect(res, "/")
    } catch {
      redirect(res, "/login?error=login_failed")
    }
  }

  private logout(req: IncomingMessage, res: ServerResponse): void {
    const session = this.session(req)
    if (!this.checkMutation(req, session)) {
      res.writeHead(session ? 403 : 401, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: false }))
      return
    }
    const token = cookie(req, sessionCookie)
    if (token) this.store.deleteSession(token)
    setCookie(res, sessionCookie, "", 0)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const login = req.method === "GET" && url.pathname === "/auth/login"
    const callback = req.method === "GET" && url.pathname === "/auth/callback"
    const logout = req.method === "POST" && url.pathname === "/auth/logout"
    if (!login && !callback && !logout) return false
    res.setHeader("cache-control", "no-store")
    this.cleanup()
    if (login) await this.login(req, res)
    else if (callback) await this.callback(req, res, url)
    else this.logout(req, res)
    return true
  }
}
