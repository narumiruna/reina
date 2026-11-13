import { pino } from "pino"
import { httpServer } from "./app.js"
import { Store } from "./jobs/store.js"
import { closeProviderAuthDispatcher } from "./settings/auth-network.js"
import { drainCredentials } from "./settings/credentials.js"
import { SettingsStore } from "./settings/store.js"
import { AdminWeb } from "./web/admin.js"
import { Auth } from "./web/auth.js"
import { loadWebConfig } from "./web/config.js"
import { Controller } from "./web/controller.js"
import { GitHubConnect } from "./web/github-connect.js"

async function main(): Promise<void> {
  const config = loadWebConfig()
  const log = pino({ level: "info" })
  const store = new Store(config.stateDir)
  let settings: SettingsStore | undefined
  try {
    settings = new SettingsStore(config.stateDir, config.encryptionKey)
    settings.bindAuthContext(
      JSON.stringify([
        "oidc-groups-v1",
        config.auth.origin,
        config.auth.issuer,
        config.auth.clientId,
        config.auth.allowedGroups,
      ]),
    )
  } catch (error) {
    settings?.close()
    store.close()
    throw error
  }
  const controller = new Controller(settings, store, process.env, log)
  const auth = new Auth(settings, config.auth)
  const admin = new AdminWeb(
    settings,
    auth,
    config.auth.origin,
    () => controller.status(),
    () => controller.reload(),
    log,
    undefined,
    new GitHubConnect(settings, auth, config.auth.origin, process.env),
  )
  const server = httpServer(() => controller.app(), log, admin)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(config.port, "127.0.0.1", resolve)
    })
    controller.reload()
    log.info({ event: "management_ready", port: config.port })
  } catch {
    admin.close()
    await controller.close()
    await drainCredentials(settings)
    await closeProviderAuthDispatcher()
    settings.close()
    store.close()
    process.exitCode = 1
    log.error({ event: "startup_failed", reason: "management_unavailable" })
    return
  }
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    admin.close()
    try {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      await controller.close()
      server.closeIdleConnections()
      await closed
    } catch {
      log.error({ event: "shutdown_failed", reason: "cleanup_requires_operator_check" })
      process.exitCode = 1
    } finally {
      await drainCredentials(settings)
      await closeProviderAuthDispatcher()
      settings.close()
      store.close()
    }
  }
  process.once("SIGTERM", () => {
    void stop()
  })
  process.once("SIGINT", () => {
    void stop()
  })
}

void main().catch(() => {
  // Do not log errors that can contain credentials or request bodies.
  console.error(
    "Reina startup failed. Check the private state directory, ENCRYPTION_KEY, and web configuration.",
  )
  process.exitCode = 1
})
