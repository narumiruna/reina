import { spawn } from "node:child_process"
import { rm } from "node:fs/promises"

const mode = process.argv[2]
if (!["cache", "install"].includes(mode)) process.exit(1)
const args = mode === "cache" ? ["cache", "add", "/tmp/dependency.tgz"] : ["ci", "--include=dev"]
args.push(
  "--ignore-scripts",
  "--offline",
  "--no-audit",
  "--no-fund",
  "--cache=/workspace/.npm-cache",
  "--logs-max=0",
)
const child = spawn("/usr/local/bin/npm", args, {
  stdio: "inherit",
  env: { ...process.env, npm_config_ignore_scripts: "true", npm_config_offline: "true" },
})
const timer = setTimeout(() => {
  child.kill("SIGKILL")
}, 120_000)
child.on("error", () => process.exit(1))
const exit = await new Promise((resolve) => child.on("close", resolve))
clearTimeout(timer)
if (exit !== 0) process.exit(1)
if (mode === "cache") await rm("/tmp/dependency.tgz")
else {
  await rm("/workspace/.npm-cache", { recursive: true, force: true })
  // npm does not create this directory for an empty dependency graph.
  const { mkdir } = await import("node:fs/promises")
  await mkdir("/workspace/node_modules", { recursive: true })
}
