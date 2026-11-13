import { mkdtempSync, rmSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { httpServer } from "../src/app.js"
import type { Store } from "../src/jobs/store.js"
import type { ModelSelection } from "../src/settings/schema.js"
import type { SettingsStore } from "../src/settings/store.js"
import type { Config } from "../src/types.js"
import type { AdminWeb } from "../src/web/admin.js"
import { Controller } from "../src/web/controller.js"

interface RuntimeFixture {
  config: Config
  cleanup: ReturnType<typeof vi.fn<() => Promise<void>>>
}
interface OrchestratorFixture {
  config: Config
  start: ReturnType<typeof vi.fn<() => Promise<void>>>
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>
}
interface AppFixture {
  ready: ReturnType<typeof vi.fn<() => Promise<void>>>
  auth: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  Probot: vi.fn(),
  DockerRuntime: vi.fn(),
  Orchestrator: vi.fn(),
  register: vi.fn(),
  boundaryFactory: vi.fn(),
  installationClient: vi.fn(),
  getAuthenticated: vi.fn(),
  getByUsername: vi.fn(),
  apps: [] as AppFixture[],
  runtimes: [] as RuntimeFixture[],
  orchestrators: [] as OrchestratorFixture[],
}))
vi.mock("probot", () => ({ Probot: mocks.Probot }))
vi.mock("../src/agent/sandbox.js", () => ({ DockerRuntime: mocks.DockerRuntime }))
vi.mock("../src/jobs/orchestrator.js", () => ({ Orchestrator: mocks.Orchestrator }))
vi.mock("../src/github/clients.js", () => ({
  LimitedOctokit: class {},
  boundaryFactory: mocks.boundaryFactory,
  installationClient: mocks.installationClient,
}))
vi.mock("../src/app.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/app.js")>()),
  register: mocks.register,
}))

let directory: string
let settings: {
  selection: ReturnType<typeof vi.fn<() => ModelSelection | undefined>>
  privateKey: ReturnType<typeof vi.fn<() => string | undefined>>
}
let env: NodeJS.ProcessEnv
const store = {} as Store
const log = { info: vi.fn(), error: vi.fn() }
const controllers: Controller[] = []
const releases: (() => void)[] = []

function selection(overrides: Partial<ModelSelection> = {}): ModelSelection {
  return {
    model: "fixture-model",
    modelUrl: "https://model.example/v1",
    modelKey: "fixture-api-key",
    modelApi: "openai-completions",
    modelProvider: "fixture-provider",
    contextWindow: 128_000,
    maxTokens: 4096,
    modelRevision: "fixture-revision-1",
    ...overrides,
  }
}
function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  releases.push(resolve)
  return { promise, resolve }
}
function controller() {
  const value = new Controller(settings as unknown as SettingsStore, store, env, log)
  controllers.push(value)
  return value
}
async function running(value: Controller) {
  await vi.waitFor(() => expect(value.status()).toEqual({ state: "running" }))
}
function expectNoRuntime() {
  expect(mocks.Probot).not.toHaveBeenCalled()
  expect(mocks.DockerRuntime).not.toHaveBeenCalled()
  expect(mocks.Orchestrator).not.toHaveBeenCalled()
  expect(mocks.installationClient).not.toHaveBeenCalled()
  expect(mocks.getAuthenticated).not.toHaveBeenCalled()
  expect(mocks.getByUsername).not.toHaveBeenCalled()
  expect(mocks.register).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.apps.length = 0
  mocks.runtimes.length = 0
  mocks.orchestrators.length = 0
  directory = mkdtempSync(join(tmpdir(), "reina-controller-"))
  env = {
    APP_ID: "123",
    WEBHOOK_SECRET: "fixture-webhook-secret-32-characters",
    REINA_REPOSITORY: "example/project",
    REINA_REPOSITORY_ID: "456",
    REINA_INSTALLATION_ID: "789",
    REINA_STATE_DIR: join(directory, "state"),
    REINA_WORKER_IMAGE: `ghcr.io/example/reina@sha256:${"d".repeat(64)}`,
    REINA_FORBIDDEN_PATHS: '["src/security/**","src/deployment/**"]',
  }
  settings = {
    selection: vi.fn(() => selection()),
    privateKey: vi.fn(() => "fixture-uploaded-pem"),
  }
  mocks.getAuthenticated.mockResolvedValue({ data: { slug: "reina-fixture" } })
  mocks.getByUsername.mockResolvedValue({ data: { id: 99, type: "Bot" } })
  mocks.installationClient.mockResolvedValue({
    client: { rest: { users: { getByUsername: mocks.getByUsername } } },
  })
  mocks.boundaryFactory.mockReturnValue("fixture-boundary-factory")
  mocks.Probot.mockImplementation(function (this: AppFixture) {
    this.ready = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    this.auth = vi.fn().mockResolvedValue({
      rest: { apps: { getAuthenticated: mocks.getAuthenticated } },
    })
    mocks.apps.push(this)
  })
  mocks.DockerRuntime.mockImplementation(function (this: RuntimeFixture, config: Config) {
    this.config = config
    this.cleanup = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    mocks.runtimes.push(this)
  })
  mocks.Orchestrator.mockImplementation(function (this: OrchestratorFixture, config: Config) {
    this.config = config
    this.start = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    this.stop = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    mocks.orchestrators.push(this)
  })
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  try {
    for (const value of controllers.splice(0)) await value.close()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("controller prerequisites", () => {
  test("construction leaves management available without starting dispatch or reading settings", () => {
    const value = controller()
    expect(value.app()).toBeUndefined()
    expect(value.status()).toEqual({ state: "not_configured", reason: "configure_model" })
    const status = value.status()
    status.state = "running"
    expect(value.status().state).toBe("not_configured")
    expect(settings.selection).not.toHaveBeenCalled()
    expect(settings.privateKey).not.toHaveBeenCalled()
    expectNoRuntime()
  })

  test("bootstrap without a model or key does not access GitHub, Docker, or dispatch config", async () => {
    settings.selection.mockReturnValue(undefined)
    settings.privateKey.mockImplementation(() => {
      throw new Error("private_key_must_not_be_read")
    })
    env = {}
    const value = controller()
    value.reload()
    await vi.waitFor(() =>
      expect(value.status()).toEqual({ state: "not_configured", reason: "configure_model" }),
    )
    expect(value.app()).toBeUndefined()
    expect(settings.privateKey).not.toHaveBeenCalled()
    expectNoRuntime()
  })

  test("requires an uploaded PEM even if a legacy environment key is present", async () => {
    settings.privateKey.mockReturnValue(undefined)
    env.PRIVATE_KEY = "ignored-environment-key"
    const value = controller()
    value.reload()
    await vi.waitFor(() =>
      expect(value.status()).toEqual({ state: "not_configured", reason: "upload_private_key" }),
    )
    expect(value.app()).toBeUndefined()
    expectNoRuntime()
  })

  test("invalid dispatch environment leaves management available and requests configuration", async () => {
    env.REINA_REPOSITORY_ID = "0"
    const value = controller()
    value.reload()
    await vi.waitFor(() =>
      expect(value.status()).toEqual({ state: "not_configured", reason: "configure_environment" }),
    )
    expect(value.app()).toBeUndefined()
    expectNoRuntime()
    env.REINA_REPOSITORY_ID = "456"
    value.reload()
    await running(value)
  })

  test("management routes work while webhook dispatch is unavailable without opening a socket", async () => {
    settings.selection.mockReturnValue(undefined)
    const value = controller()
    const handle = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== "/") return false
      res.writeHead(200).end("management")
      return true
    })
    const server = httpServer(() => value.app(), log, { handle } as unknown as AdminWeb)
    for (const [url, method, status, body] of [
      ["/", "GET", 200, "management"],
      ["/healthz", "GET", 200, "ok"],
      ["/api/github/webhooks", "POST", 503, undefined],
    ] as const) {
      const req = { url, method, resume: vi.fn() }
      const res = { writeHead: vi.fn(), end: vi.fn() }
      res.writeHead.mockReturnValue(res)
      server.emit("request", req, res)
      await vi.waitFor(() => expect(res.end).toHaveBeenCalled())
      expect(res.writeHead).toHaveBeenCalledWith(status)
      if (body) expect(res.end).toHaveBeenCalledWith(body)
      if (status === 503) expect(req.resume).toHaveBeenCalledOnce()
    }
    expect(server.listening).toBe(false)
    expectNoRuntime()
  })

  test("settings read failures leave the app unavailable and do not log secrets", async () => {
    settings.selection.mockImplementation(() => {
      throw new Error("secret-settings-input")
    })
    const value = controller()
    value.reload()
    await vi.waitFor(() =>
      expect(value.status()).toEqual({ state: "failed", reason: "settings_unavailable" }),
    )
    expect(value.app()).toBeUndefined()
    expectNoRuntime()
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret-settings-input")
  })
})

describe("controller runtime lifecycle", () => {
  test("starts Probot only with stored selection, uploaded PEM, and valid dispatch settings", async () => {
    env.PRIVATE_KEY = "ignored-environment-key"
    const selected = selection()
    settings.selection.mockReturnValue(selected)
    const value = controller()
    value.reload()
    expect(value.status()).toEqual({ state: "starting" })
    expect(value.app()).toBeUndefined()
    await running(value)
    const config = mocks.runtimes[0].config
    expect(config).toMatchObject({
      ...selected,
      repository: { owner: "example", name: "project", id: 456, installationId: 789 },
    })
    expect(mocks.Probot).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "123",
        privateKey: "fixture-uploaded-pem",
        secret: env.WEBHOOK_SECRET,
      }),
    )
    expect(mocks.apps[0].ready).toHaveBeenCalledOnce()
    expect(mocks.installationClient).toHaveBeenCalledWith(mocks.apps[0], config, false)
    expect(mocks.getByUsername).toHaveBeenCalledWith({
      username: "reina-fixture[bot]",
      request: { retries: 0 },
    })
    expect(mocks.Orchestrator).toHaveBeenCalledWith(
      config,
      store,
      mocks.runtimes[0],
      "fixture-boundary-factory",
      99,
      log,
    )
    expect(mocks.register).toHaveBeenCalledWith(mocks.apps[0], config, mocks.orchestrators[0], 99)
    expect(mocks.orchestrators[0].start).toHaveBeenCalledOnce()
    expect(mocks.runtimes[0].cleanup).not.toHaveBeenCalled()
    expect(value.app()).toBe(mocks.apps[0])
  })

  test("reload disables dispatch and stops prior work before it starts the new selection snapshot", async () => {
    const selected = selection()
    settings.selection.mockReturnValue(selected)
    const value = controller()
    value.reload()
    await running(value)
    const original = mocks.orchestrators[0].config
    const stopped = deferred()
    mocks.orchestrators[0].stop.mockReturnValue(stopped.promise)
    const next = selection({
      model: "second-model",
      modelUrl: "https://other.example/v2",
      modelKey: "rotated-fixture-key",
      modelApi: "openai-responses",
      modelRevision: "fixture-revision-2",
    })
    settings.selection.mockReturnValue(next)
    value.reload()
    expect(value.app()).toBeUndefined()
    expect(value.status()).toEqual({ state: "starting" })
    expect(mocks.orchestrators[0].stop).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(mocks.Probot).toHaveBeenCalledTimes(1)
    stopped.resolve()
    await running(value)
    expect(mocks.orchestrators).toHaveLength(2)
    expect(mocks.orchestrators[1].config).toMatchObject(next)
    expect(mocks.runtimes[1].config).toBe(mocks.orchestrators[1].config)
    expect(original).toMatchObject(selected)
    expect(original).not.toBe(mocks.orchestrators[1].config)
    next.modelKey = "later-settings-mutation"
    expect(mocks.orchestrators[1].config.modelKey).toBe("rotated-fixture-key")
    expect(value.app()).toBe(mocks.apps[1])
  })

  test("removing selection retires the running app without starting another runtime", async () => {
    const value = controller()
    value.reload()
    await running(value)
    settings.selection.mockReturnValue(undefined)
    value.reload()
    expect(value.app()).toBeUndefined()
    expect(mocks.orchestrators[0].stop).toHaveBeenCalledOnce()
    await vi.waitFor(() =>
      expect(value.status()).toEqual({ state: "not_configured", reason: "configure_model" }),
    )
    expect(mocks.Probot).toHaveBeenCalledTimes(1)
  })

  test("queued reloads discard obsolete generations before setup", async () => {
    const value = controller()
    value.reload()
    settings.selection.mockReturnValue(selection({ model: "latest-model" }))
    value.reload()
    await running(value)
    expect(mocks.Probot).toHaveBeenCalledOnce()
    expect(mocks.orchestrators[0].config.model).toBe("latest-model")
  })

  test("reload during Probot readiness cleans up the stale runtime without authenticating it", async () => {
    const ready = deferred()
    mocks.Probot.mockImplementationOnce(function (this: AppFixture) {
      this.ready = vi.fn(() => ready.promise)
      this.auth = vi.fn()
      mocks.apps.push(this)
    })
    const value = controller()
    value.reload()
    await vi.waitFor(() => expect(mocks.apps[0]?.ready).toHaveBeenCalledOnce())
    settings.selection.mockReturnValue(selection({ model: "latest-model" }))
    value.reload()
    ready.resolve()
    await running(value)
    expect(mocks.apps[0].auth).not.toHaveBeenCalled()
    expect(mocks.runtimes[0].cleanup).toHaveBeenCalledOnce()
    expect(mocks.orchestrators).toHaveLength(1)
    expect(mocks.orchestrators[0].config.model).toBe("latest-model")
    expect(value.app()).toBe(mocks.apps[1])
  })

  test("reload during orchestrator start stops stale work and never exposes its app", async () => {
    const start = deferred()
    mocks.register.mockImplementationOnce(() => {
      mocks.orchestrators[0].start.mockReturnValue(start.promise)
    })
    const value = controller()
    value.reload()
    await vi.waitFor(() => expect(mocks.orchestrators[0]?.start).toHaveBeenCalledOnce())
    expect(value.app()).toBeUndefined()
    value.reload()
    expect(mocks.orchestrators[0].stop).toHaveBeenCalledOnce()
    start.resolve()
    await running(value)
    expect(value.app()).toBe(mocks.apps[1])
    expect(mocks.orchestrators[1].start).toHaveBeenCalledOnce()
  })

  test.each([
    "worker_image_not_prepared",
    "worker_pi_version_mismatch",
    "docker_seccomp_unavailable",
    "runtime_controls_unavailable",
    "runtime_socket_unavailable",
    "runtime_frozen_export_unavailable",
  ])("preserves the safe startup reason %s without error context", async (reason) => {
    const error = new Error(reason, { cause: new Error("private-startup-cause") })
    error.stack = "private-startup-stack"
    mocks.register.mockImplementationOnce(() => {
      mocks.orchestrators[0].start.mockRejectedValueOnce(error)
    })
    const value = controller()
    value.reload()
    await vi.waitFor(() => expect(value.status()).toEqual({ state: "failed", reason }))
    expect(value.app()).toBeUndefined()
    expect(log.error).toHaveBeenCalledWith({ event: "runtime_configuration_failed", reason })
    const logs = JSON.stringify([log.info.mock.calls, log.error.mock.calls])
    expect(logs).not.toContain("private-startup-cause")
    expect(logs).not.toContain("private-startup-stack")
  })

  test.each([
    "private-startup-error",
    "worker_image_not_prepared private-startup-secret",
    "private-startup-secret runtime_controls_unavailable",
  ])("does not log an unknown startup error: %s", async (message) => {
    mocks.register.mockImplementationOnce(() => {
      mocks.orchestrators[0].start.mockRejectedValueOnce(new Error(message))
    })
    const value = controller()
    value.reload()
    await vi.waitFor(() =>
      expect(value.status()).toEqual({
        state: "failed",
        reason: "authentication_or_sandbox_unavailable",
      }),
    )
    expect(log.error).toHaveBeenCalledWith({
      event: "runtime_configuration_failed",
      reason: "authentication_or_sandbox_unavailable",
    })
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(message)
  })

  test.each(["authentication", "bot lookup", "sandbox start", "webhook registration"])(
    "failed %s setup keeps the app unavailable and releases resources",
    async (phase) => {
      const secretError = new Error("secret-runtime-error")
      if (phase === "authentication") mocks.getAuthenticated.mockRejectedValueOnce(secretError)
      if (phase === "bot lookup") mocks.getByUsername.mockRejectedValueOnce(secretError)
      if (phase === "sandbox start")
        mocks.register.mockImplementationOnce(() => {
          mocks.orchestrators[0].start.mockRejectedValueOnce(secretError)
        })
      if (phase === "webhook registration")
        mocks.register.mockImplementationOnce(() => {
          throw secretError
        })
      const value = controller()
      value.reload()
      await vi.waitFor(() =>
        expect(value.status()).toEqual({
          state: "failed",
          reason: "authentication_or_sandbox_unavailable",
        }),
      )
      expect(value.app()).toBeUndefined()
      if (mocks.orchestrators.length) expect(mocks.orchestrators[0].stop).toHaveBeenCalledOnce()
      else expect(mocks.runtimes[0].cleanup).toHaveBeenCalledOnce()
      expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret-runtime-error")
      value.reload()
      await running(value)
      expect(value.app()).toBe(mocks.apps[1])
    },
  )

  test("cleanup failure prevents replacement dispatch even when reloads overlap", async () => {
    const value = controller()
    value.reload()
    await running(value)
    mocks.orchestrators[0].stop.mockRejectedValueOnce(new Error("secret-cleanup-error"))
    value.reload()
    value.reload()
    await vi.waitFor(() =>
      expect(value.status()).toEqual({
        state: "failed",
        reason: "cleanup_requires_operator_check",
      }),
    )
    expect(value.app()).toBeUndefined()
    expect(mocks.Probot).toHaveBeenCalledTimes(1)
    expect(mocks.orchestrators[0].stop).toHaveBeenCalledOnce()
    value.reload()
    expect(value.status()).toEqual({ state: "failed", reason: "cleanup_requires_operator_check" })
    expect(mocks.Probot).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret-cleanup-error")
    await expect(value.close()).rejects.toThrow("runtime_cleanup_failed")
    controllers.splice(controllers.indexOf(value), 1)
  })

  test("close removes the app, awaits stopped work, and ignores further reloads", async () => {
    const value = controller()
    value.reload()
    await running(value)
    const stop = deferred()
    mocks.orchestrators[0].stop.mockReturnValue(stop.promise)
    let closed = false
    const closing = value.close().then(() => {
      closed = true
    })
    expect(value.app()).toBeUndefined()
    expect(mocks.orchestrators[0].stop).toHaveBeenCalledOnce()
    value.reload()
    await Promise.resolve()
    expect(closed).toBe(false)
    stop.resolve()
    await closing
    await value.close()
    expect(mocks.Probot).toHaveBeenCalledTimes(1)
    expect(mocks.orchestrators[0].stop).toHaveBeenCalledOnce()
  })

  test("close rejects when stale startup cleanup fails", async () => {
    const ready = deferred()
    mocks.Probot.mockImplementationOnce(function (this: AppFixture) {
      this.ready = vi.fn(() => ready.promise)
      this.auth = vi.fn()
      mocks.apps.push(this)
    })
    const value = controller()
    value.reload()
    await vi.waitFor(() => expect(mocks.apps[0]?.ready).toHaveBeenCalledOnce())
    mocks.runtimes[0].cleanup.mockRejectedValueOnce(new Error("private-cleanup-error"))
    const closing = expect(value.close()).rejects.toThrow("runtime_cleanup_failed")
    ready.resolve()
    await closing
    expect(value.app()).toBeUndefined()
    expect(value.status()).toEqual({ state: "failed", reason: "cleanup_requires_operator_check" })
    expect(mocks.apps[0].auth).not.toHaveBeenCalled()
    controllers.splice(controllers.indexOf(value), 1)
  })

  test("logs stale startup cleanup failure before replacement dispatch is blocked", async () => {
    const ready = deferred()
    mocks.Probot.mockImplementationOnce(function (this: AppFixture) {
      this.ready = vi.fn(() => ready.promise)
      this.auth = vi.fn()
      mocks.apps.push(this)
    })
    const value = controller()
    value.reload()
    await vi.waitFor(() => expect(mocks.apps[0]?.ready).toHaveBeenCalledOnce())
    mocks.runtimes[0].cleanup.mockRejectedValueOnce(new Error("private-cleanup-error"))
    value.reload()
    ready.resolve()
    await vi.waitFor(() =>
      expect(value.status()).toEqual({
        state: "failed",
        reason: "cleanup_requires_operator_check",
      }),
    )
    expect(log.error).toHaveBeenCalledExactlyOnceWith({
      event: "runtime_stop_failed",
      reason: "cleanup_requires_operator_check",
    })
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("private-cleanup-error")
    expect(value.app()).toBeUndefined()
    expect(mocks.Probot).toHaveBeenCalledOnce()
    expect(mocks.apps[0].auth).not.toHaveBeenCalled()
    await expect(value.close()).rejects.toThrow("runtime_cleanup_failed")
    controllers.splice(controllers.indexOf(value), 1)
  })

  test("logs cleanup failure after startup failure without replacing its reason", async () => {
    mocks.register.mockImplementationOnce(() => {
      mocks.orchestrators[0].start.mockRejectedValueOnce(new Error("worker_pi_version_mismatch"))
      mocks.orchestrators[0].stop.mockRejectedValueOnce(new Error("private-stop-error"))
    })
    const value = controller()
    value.reload()
    await vi.waitFor(() =>
      expect(value.status()).toEqual({
        state: "failed",
        reason: "cleanup_requires_operator_check",
      }),
    )
    expect(log.error.mock.calls).toEqual([
      [{ event: "runtime_configuration_failed", reason: "worker_pi_version_mismatch" }],
      [{ event: "runtime_stop_failed", reason: "cleanup_requires_operator_check" }],
    ])
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("private-stop-error")
    expect(value.app()).toBeUndefined()
    await expect(value.close()).rejects.toThrow("runtime_cleanup_failed")
    controllers.splice(controllers.indexOf(value), 1)
  })

  test("close during startup waits for cleanup without authenticating or publishing an app", async () => {
    const ready = deferred()
    mocks.Probot.mockImplementationOnce(function (this: AppFixture) {
      this.ready = vi.fn(() => ready.promise)
      this.auth = vi.fn()
      mocks.apps.push(this)
    })
    const value = controller()
    value.reload()
    await vi.waitFor(() => expect(mocks.apps[0]?.ready).toHaveBeenCalledOnce())
    const closing = value.close()
    value.reload()
    ready.resolve()
    await closing
    expect(value.app()).toBeUndefined()
    expect(mocks.apps[0].auth).not.toHaveBeenCalled()
    expect(mocks.runtimes[0].cleanup).toHaveBeenCalledOnce()
    expect(mocks.Orchestrator).not.toHaveBeenCalled()
    expect(mocks.Probot).toHaveBeenCalledOnce()
  })
})
