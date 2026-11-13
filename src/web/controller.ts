import { Probot } from "probot"
import { DockerRuntime } from "../agent/sandbox.js"
import { register } from "../app.js"
import { loadRuntimeConfig, stateDirectorySchema } from "../config.js"
import { boundaryFactory, installationClient, LimitedOctokit } from "../github/clients.js"
import { numericId } from "../github/scanner.js"
import { Orchestrator } from "../jobs/orchestrator.js"
import type { Store } from "../jobs/store.js"
import type { SettingsStore } from "../settings/store.js"
import type { Logger } from "../types.js"

const startupReasons = new Set([
  "app_identity_missing",
  "bot_identity_missing",
  "installation_token_invalid",
  "installation_scope_invalid",
  "docker_operation_failed",
  "docker_unavailable",
  "docker_stdout_limit",
  "docker_stderr_limit",
  "docker_seccomp_unavailable",
  "worker_image_not_pinned",
  "worker_image_identity_mismatch",
  "worker_image_not_prepared",
  "worker_pi_version_mismatch",
  "worker_start_failed",
  "worker_import_failed",
  "runtime_controls_unavailable",
  "runtime_socket_unavailable",
  "runtime_frozen_export_unavailable",
  "container_cleanup_failed",
  "volume_cleanup_failed",
])

export interface RuntimeStatus {
  state: "starting" | "running" | "not_configured" | "failed"
  reason?: string
}

/** The management server remains available while dispatch is stopped or being configured. */
export class Controller {
  private currentApp?: Probot
  private orchestrator?: Orchestrator
  private queue = Promise.resolve()
  private generation = 0
  private stopping = false
  private cleanupFailed = false
  private currentStatus: RuntimeStatus = { state: "not_configured", reason: "configure_model" }

  constructor(
    private readonly settings: SettingsStore,
    private readonly store: Store,
    private readonly env: NodeJS.ProcessEnv,
    private readonly log: Logger,
  ) {}

  app(): Probot | undefined {
    return this.currentApp
  }
  status(): RuntimeStatus {
    return { ...this.currentStatus }
  }

  reload(): void {
    if (this.stopping) return
    if (this.cleanupFailed) {
      this.currentStatus = { state: "failed", reason: "cleanup_requires_operator_check" }
      return
    }
    const generation = ++this.generation
    this.currentApp = undefined
    this.currentStatus = { state: "starting" }
    // stop() aborts existing work before its first await. No old dispatch remains enabled.
    const stopped = this.orchestrator?.stop().catch(() => {
      this.cleanupFailed = true
      this.log.error({ event: "runtime_stop_failed", reason: "cleanup_requires_operator_check" })
      throw new Error("runtime_cleanup_failed")
    })
    this.orchestrator = undefined
    // Attach a rejection handler immediately, even when another reload is queued.
    const retirement = stopped ? Promise.allSettled([stopped]) : Promise.resolve([])
    this.queue = this.queue
      .then(async () => {
        const results = await retirement
        if (this.cleanupFailed || results.some((result) => result.status === "rejected")) {
          this.cleanupFailed = true
          this.currentStatus = { state: "failed", reason: "cleanup_requires_operator_check" }
          return
        }
        if (generation !== this.generation || this.stopping) return
        await this.apply(generation)
      })
      .catch(() => {
        if (generation === this.generation)
          this.currentStatus = {
            state: "failed",
            reason: this.cleanupFailed ? "cleanup_requires_operator_check" : "settings_unavailable",
          }
        this.log.error({ event: "runtime_configuration_failed", reason: "settings_unavailable" })
      })
  }

  private async apply(generation: number): Promise<void> {
    const selection = this.settings.selection()
    if (!selection) {
      this.currentStatus = { state: "not_configured", reason: "configure_model" }
      return
    }
    const privateKey = this.settings.privateKey()
    if (!privateKey) {
      this.currentStatus = { state: "not_configured", reason: "upload_private_key" }
      return
    }
    // Read saved settings outside the legacy-validation catch. Corrupt saved data fails closed.
    const saved = this.settings.dispatchSettings()
    const appSettings = this.settings.githubAppSettings()
    const connection = this.settings.githubConnection()
    let configured: ReturnType<typeof loadRuntimeConfig>
    try {
      configured = saved
        ? { ...saved, stateDir: stateDirectorySchema.parse(this.env.REINA_STATE_DIR) }
        : loadRuntimeConfig(this.env)
    } catch {
      this.currentStatus = { state: "not_configured", reason: "configure_runtime" }
      return
    }
    const { appId, webhookSecret, ...environment } = configured
    if (
      (appSettings && appSettings.appId !== appId) ||
      (connection &&
        (connection.appId !== appId ||
          connection.repository.id !== environment.repository.id ||
          connection.repository.installationId !== environment.repository.installationId ||
          connection.repository.owner !== environment.repository.owner ||
          connection.repository.name !== environment.repository.name))
    ) {
      this.currentStatus = { state: "not_configured", reason: "configure_runtime" }
      return
    }
    const config = { ...environment, ...selection }
    const runtime = new DockerRuntime(config)
    let orchestrator: Orchestrator | undefined
    let active = false
    const stale = () => this.stopping || generation !== this.generation
    try {
      const app = new Probot({
        appId,
        privateKey,
        secret: appSettings?.webhookSecret ?? webhookSecret,
        Octokit: LimitedOctokit,
        logLevel: "info",
        logFormat: "json",
      })
      await app.ready()
      if (stale()) return
      const root = await app.auth()
      const { data: metadata } = await root.rest.apps.getAuthenticated({ request: { retries: 0 } })
      if (!metadata?.slug) throw new Error("app_identity_missing")
      if (stale()) return
      const read = await installationClient(app, config, false)
      const { data: bot } = await read.client.rest.users.getByUsername({
        username: `${metadata.slug}[bot]`,
        request: { retries: 0 },
      })
      if (bot.type !== "Bot" || !bot.id) throw new Error("bot_identity_missing")
      if (stale()) return
      const botId = numericId(bot.id)
      orchestrator = new Orchestrator(
        config,
        this.store,
        runtime,
        boundaryFactory(app, config, botId),
        botId,
        this.log,
      )
      this.orchestrator = orchestrator
      register(app, config, orchestrator, botId)
      await orchestrator.start()
      if (stale()) return
      this.currentApp = app
      this.currentStatus = { state: "running" }
      active = true
      this.log.info({
        event: "runtime_ready",
        repositoryId: config.repository.id,
        installationId: config.repository.installationId,
      })
    } catch (error) {
      const reason =
        error instanceof Error && startupReasons.has(error.message)
          ? error.message
          : "authentication_or_sandbox_unavailable"
      if (!stale()) this.currentStatus = { state: "failed", reason }
      this.log.error({ event: "runtime_configuration_failed", reason })
    } finally {
      if (!active) {
        if (this.orchestrator === orchestrator) this.orchestrator = undefined
        try {
          if (orchestrator) await orchestrator.stop()
          else await runtime.cleanup()
        } catch {
          this.cleanupFailed = true
          this.currentStatus = { state: "failed", reason: "cleanup_requires_operator_check" }
          this.log.error({
            event: "runtime_stop_failed",
            reason: "cleanup_requires_operator_check",
          })
        }
      }
    }
  }

  async close(): Promise<void> {
    this.stopping = true
    this.generation++
    this.currentApp = undefined
    const stopped = this.orchestrator?.stop()
    this.orchestrator = undefined
    const results = await Promise.allSettled([this.queue, stopped])
    if (this.cleanupFailed || results.some((result) => result.status === "rejected"))
      throw new Error("runtime_cleanup_failed")
  }
}
