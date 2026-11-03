import assert from "node:assert/strict"
import { readFile, statfs, writeFile } from "node:fs/promises"
import os from "node:os"

assert.equal(process.getuid(), 1000)
const status = await readFile("/proc/self/status", "utf8")
assert.match(status, /^NoNewPrivs:\s+1$/m)
assert.match(status, /^Seccomp:\s+2$/m)
assert.match(status, /^CapEff:\s+0+$/m)
assert.equal((await readFile("/sys/fs/cgroup/memory.max", "utf8")).trim(), "2147483648")
assert.equal((await readFile("/sys/fs/cgroup/pids.max", "utf8")).trim(), "128")
const [quota, period] = (await readFile("/sys/fs/cgroup/cpu.max", "utf8"))
  .trim()
  .split(" ")
  .map(Number)
assert.equal(quota / period, 1)
const workspace = await statfs("/workspace")
const temporary = await statfs("/tmp")
assert.equal(workspace.blocks * workspace.bsize, 256 * 1024 * 1024)
assert.equal(temporary.blocks * temporary.bsize, 64 * 1024 * 1024)
await assert.rejects(writeFile("/rootfs-write-probe", "blocked"), { code: "EROFS" })
assert.equal(Object.keys(os.networkInterfaces()).join(","), "lo")
assert.equal(process.env.HOME, "/tmp/home")
assert.equal(process.env.OPENAI_API_KEY, undefined)
assert.equal(process.env.ANTHROPIC_API_KEY, undefined)
for (const name of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "FTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "ftp_proxy",
  "all_proxy",
  "no_proxy",
])
  assert.ok(!process.env[name])
for (const name of [
  "PRIVATE_KEY",
  "WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "REINA_MODEL_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
])
  assert.equal(process.env[name], undefined)
await assert.rejects(readFile("/var/run/docker.sock"))
process.stdout.write("controls_verified\n")
