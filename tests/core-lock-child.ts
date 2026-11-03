import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"

// Native TypeScript stripping does not rewrite .js source imports. Keep this
// mapping in the test process only; production runs compiled JavaScript.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const source = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL)
      if (existsSync(fileURLToPath(source))) return nextResolve(source.href, context)
    }
    return nextResolve(specifier, context)
  },
})

try {
  const { Store } = await import("../src/jobs/store.ts")
  const store = new Store(process.argv[2])
  store.acceptDelivery("lock-probe", { kind: "scan" })
  store.completeDelivery("lock-probe")
  process.send?.("ready")
  const timer = setInterval(() => {}, 60_000)
  process.on("message", () => {
    clearInterval(timer)
    store.close()
    process.exit(0)
  })
} catch {
  process.send?.("locked")
  process.exitCode = 2
}
