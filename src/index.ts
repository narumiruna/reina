import { Probot } from "probot"
import { DockerRuntime } from "./agent/sandbox.js"
import { httpServer, register } from "./app.js"
import { loadConfig } from "./config.js"
import { boundaryFactory, installationClient, LimitedOctokit } from "./github/clients.js"
import { numericId } from "./github/scanner.js"
import { Orchestrator } from "./jobs/orchestrator.js"
import { Store } from "./jobs/store.js"

async function main(): Promise<void> {
  const config = loadConfig()
  const app = new Probot({
    appId: process.env.APP_ID,
    privateKey: process.env.PRIVATE_KEY?.replace(/\\n/g, "\n"),
    secret: process.env.WEBHOOK_SECRET,
    Octokit: LimitedOctokit,
    logLevel: "info",
    logFormat: "json",
  })
  await app.ready()
  const store = new Store(config.stateDir)
  const runtime = new DockerRuntime(config)
  let orchestrator: Orchestrator | undefined
  const server = httpServer(app)
  try {
    const root = await app.auth()
    const { data: metadata } = await root.rest.apps.getAuthenticated({ request: { retries: 0 } })
    if (!metadata?.slug) throw new Error("app_identity_missing")
    const read = await installationClient(app, config, false)
    const { data: bot } = await read.client.rest.users.getByUsername({
      username: `${metadata.slug}[bot]`,
      request: { retries: 0 },
    })
    if (bot.type !== "Bot" || !bot.id) throw new Error("bot_identity_missing")
    const botId = numericId(bot.id)
    orchestrator = new Orchestrator(
      config,
      store,
      runtime,
      boundaryFactory(app, config, botId),
      botId,
      app.log,
    )
    register(app, config, orchestrator, botId)
    await orchestrator.start()
    const port = Number(process.env.PORT ?? 3000)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("port_invalid")
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(port, "127.0.0.1", resolve)
    })
    app.log.info({
      event: "ready",
      port,
      repositoryId: config.repository.id,
      installationId: config.repository.installationId,
    })
  } catch {
    await orchestrator?.stop()
    await runtime.cleanup()
    store.close()
    app.log.error({
      event: "startup_failed",
      reason: "configuration_authentication_or_sandbox_unavailable",
    })
    process.exitCode = 1
    return
  }
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    try {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      await orchestrator?.stop()
      await closed
    } catch {
      app.log.error({ event: "shutdown_failed", reason: "cleanup_requires_operator_check" })
      process.exitCode = 1
    } finally {
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
  // Configuration errors can contain secret values; never print the thrown object.
  console.error(
    "Reina startup failed. Check the required configuration and operating instructions.",
  )
  process.exitCode = 1
})
