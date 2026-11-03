import type { Probot } from "probot"
import { afterEach, describe, expect, test, vi } from "vitest"
import { boundaryFactory, installationClient } from "../src/github/clients.js"
import type { Config } from "../src/types.js"

const config = {
  repository: { owner: "example", name: "project", id: 456, installationId: 789 },
} as Config
function setup(change: (value: Record<string, unknown>) => void = () => {}) {
  const auth = vi.fn(
    async (options: { permissions: Record<string, string>; refresh?: boolean }) => {
      const value = {
        token: "ghs_credential_free_fixture",
        tokenType: "installation",
        installationId: 789,
        repositoryIds: [456],
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: options.permissions,
      }
      change(value)
      return value
    },
  )
  const app = {
    auth: vi.fn(async () => ({ auth })),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as Probot
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected GitHub request")
    }),
  )
  return { app, auth }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("narrow installation-token issuance", () => {
  test("requests explicit scopes per auth call instead of relying on strategy defaults", async () => {
    const { app, auth } = setup()
    const read = await installationClient(app, config, false)
    expect(auth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 789,
      repositoryIds: [456],
      permissions: { metadata: "read", contents: "read", issues: "read", pull_requests: "read" },
      refresh: true,
    })
    expect(await read.client.auth({ type: "installation" })).toMatchObject({
      token: read.auth.token,
      tokenType: "installation",
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test("caches separate read/write clients with authenticated repository proof", async () => {
    const { app, auth } = setup()
    const factory = boundaryFactory(app, config, 99)
    const first = await factory()
    expect(await factory()).toBe(first)
    expect(auth).toHaveBeenCalledTimes(2)
    expect(auth.mock.calls[1][0].permissions).toEqual({
      metadata: "read",
      contents: "write",
      issues: "write",
      pull_requests: "write",
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test("client renewal requests fresh scoped credentials beyond the 45-minute boundary", async () => {
    let now = Date.now()
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const { app, auth } = setup()
    const responses = new Map<string, Awaited<ReturnType<typeof auth>>>()
    auth.mockImplementation(async (options) => {
      const key = JSON.stringify(options.permissions)
      const previous = responses.get(key)
      if (previous && !options.refresh) return previous
      const result = {
        token: "ghs_credential_free_fixture",
        tokenType: "installation",
        installationId: 789,
        repositoryIds: [456],
        expiresAt: new Date(now + 3_600_000).toISOString(),
        permissions: options.permissions,
      }
      responses.set(key, result)
      return result
    })
    const factory = boundaryFactory(app, config, 99)
    const first = await factory()
    now += 46 * 60_000
    expect(await factory()).not.toBe(first)
    expect(auth).toHaveBeenCalledTimes(4)
    expect(auth.mock.calls.every(([options]) => options.refresh === true)).toBe(true)
  })

  test("token-issuance rate limits retain Retry-After without retrying POST", async () => {
    const now = Date.now()
    vi.spyOn(Date, "now").mockReturnValue(now)
    const { app, auth } = setup()
    auth.mockRejectedValueOnce(
      Object.assign(new Error("private response"), {
        status: 429,
        response: { headers: { "retry-after": "3600" } },
      }),
    )
    await expect(installationClient(app, config, false)).rejects.toMatchObject({
      code: "github_auth_unavailable",
      retryAt: now + 3_600_000,
    })
    expect(auth).toHaveBeenCalledTimes(1)
  })

  test.each([
    [
      "wrong installation",
      (value: Record<string, unknown>) => {
        value.installationId = 1
      },
    ],
    [
      "wrong repository",
      (value: Record<string, unknown>) => {
        value.repositoryIds = [123]
      },
    ],
    [
      "multiple repositories",
      (value: Record<string, unknown>) => {
        value.repositoryIds = [456, 123]
      },
    ],
    [
      "missing repository scope",
      (value: Record<string, unknown>) => {
        delete value.repositoryIds
      },
    ],
    [
      "unscoped token",
      (value: Record<string, unknown>) => {
        value.tokenType = "oauth"
      },
    ],
    [
      "expired token",
      (value: Record<string, unknown>) => {
        value.expiresAt = new Date(0).toISOString()
      },
    ],
    [
      "invalid expiry",
      (value: Record<string, unknown>) => {
        value.expiresAt = "invalid"
      },
    ],
    [
      "excess permissions",
      (value: Record<string, unknown>) => {
        value.permissions = { ...(value.permissions as object), administration: "write" }
      },
    ],
    [
      "write token for read stage",
      (value: Record<string, unknown>) => {
        value.permissions = { ...(value.permissions as object), contents: "write" }
      },
    ],
  ])("rejects %s", async (_name, change) => {
    const { app } = setup(change)
    await expect(installationClient(app, config, false)).rejects.toThrow(
      /installation_(scope|token)_invalid/,
    )
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
