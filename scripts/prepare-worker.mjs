#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import tar from "tar-stream"

const baseDigest =
  "node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567"
const baseTag = "reina-worker-base:pi-1.5.0"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const deadline = Date.now() + 600_000
const [source, tag] = process.argv.slice(2)
if (!source || !tag || process.argv.length !== 4 || !/^[a-z0-9][a-z0-9./:_-]{0,127}$/.test(tag)) {
  process.stderr.write(
    "Usage: node scripts/prepare-worker.mjs <approved-snapshot-directory> <local-image-tag>\n",
  )
  process.exit(1)
}

async function command(
  argv,
  { input, limit = 128 * 1024, timeout = 240_000, report = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"] })
    const chunks = []
    let size = 0
    let errors = 0
    let failure
    const stop = (reason) => {
      failure ??= new Error(reason)
      child.kill("SIGKILL")
    }
    const cleanup = argv[0] === "rm" || (argv[0] === "volume" && argv[1] === "rm")
    const timer = setTimeout(
      () => stop("preparation_timeout"),
      cleanup ? timeout : Math.max(1, Math.min(timeout, deadline - Date.now())),
    )
    child.stdout.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) stop("preparation_output_limit")
      else if (report) process.stderr.write(chunk)
      else chunks.push(chunk)
    })
    child.stderr.on("data", (chunk) => {
      errors += chunk.length
      if (errors > 128 * 1024) stop("preparation_diagnostic_limit")
      else if (report) process.stderr.write(chunk)
    })
    child.stdin.on("error", () => {})
    child.once("error", () => {
      failure = new Error("docker_unavailable")
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (failure || code !== 0) reject(failure ?? new Error(`preparation_${argv[0]}_failed`))
      else resolve(Buffer.concat(chunks))
    })
    child.stdin.end(input)
  })
}

async function archive(entries) {
  const pack = tar.pack()
  const chunks = []
  const collect = (async () => {
    for await (const chunk of pack) chunks.push(chunk)
  })()
  for (const [name, content] of entries)
    pack.entry({ name, mode: 0o644, uid: 1000, gid: 1000, size: content.length }, content)
  pack.finalize()
  await collect
  return Buffer.concat(chunks)
}

async function importFiles(containerId, kind, files) {
  const input = Buffer.from(
    JSON.stringify(
      files.map(([name, bytes]) => ({
        path: name,
        mode: "100644",
        content: bytes.toString("base64"),
      })),
    ),
  )
  await command(["exec", "--interactive", containerId, "node", "/opt/reina/import.mjs", kind], {
    input,
  })
}

async function approvedFile(name) {
  const file = path.join(source, name)
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error("invalid_approved_manifest")
  return readFile(file)
}

function approvedDependencies(lock, manifest) {
  if (
    lock.lockfileVersion !== 3 ||
    !lock.packages ||
    manifest.workspaces ||
    lock.packages[""]?.workspaces
  )
    throw new Error("unsupported_dependency_lock")
  const packages = Object.entries(lock.packages)
  if (packages.length > 2000) throw new Error("dependency_count_limit")
  const urls = new Map()
  for (const [name, entry] of packages) {
    if (!name) continue
    if (
      !/^node_modules\//.test(name) ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      entry.link ||
      typeof entry.resolved !== "string" ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity ?? "")
    )
      throw new Error("unsupported_dependency_source")
    const url = new URL(entry.resolved)
    if (
      url.protocol !== "https:" ||
      url.hostname !== "registry.npmjs.org" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !/^\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*\/-\/[A-Za-z0-9._-]+\.tgz$/.test(
        url.pathname,
      )
    )
      throw new Error("dependency_registry_only")
    if (urls.has(url.href) && urls.get(url.href) !== entry.integrity)
      throw new Error("dependency_integrity_conflict")
    urls.set(url.href, entry.integrity)
  }
  return urls
}

async function download(url, integrity, budget) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
    headers: { accept: "application/octet-stream" },
  })
  if (!response.ok || !response.body) throw new Error("dependency_download_failed")
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    budget.bytes += chunk.length
    if (bytes > 32 * 1024 * 1024 || budget.bytes > 128 * 1024 * 1024) {
      await response.body.cancel().catch(() => {})
      throw new Error("dependency_download_limit")
    }
    chunks.push(Buffer.from(chunk))
  }
  const data = Buffer.concat(chunks)
  if (`sha512-${createHash("sha512").update(data).digest("base64")}` !== integrity)
    throw new Error("dependency_integrity_failed")
  return data
}

async function sanitizeDependencies(bytes) {
  const extract = tar.extract()
  const pack = tar.pack()
  const chunks = []
  const collect = (async () => {
    for await (const chunk of pack) chunks.push(chunk)
  })()
  let entries = 0
  let total = 0
  const seen = new Set()
  const links = new Map()
  const completed = new Promise((resolve, reject) => {
    extract.once("finish", resolve)
    extract.once("error", reject)
    extract.on("entry", (header, stream, next) => {
      void (async () => {
        const name = header.name.replace(/\/$/, "")
        if (
          ++entries > 20_000 ||
          !/^node_modules(?:\/|$)/.test(name) ||
          name.length > 512 ||
          /[\p{Cc}\\]/u.test(name) ||
          name.split("/").some((part) => !part || part === "." || part === "..") ||
          seen.has(name)
        )
          throw new Error("unsafe_dependency_archive")
        seen.add(name)
        if (header.type === "directory") pack.entry({ name, type: "directory", mode: 0o755 })
        else if (header.type === "symlink") {
          const target = header.linkname
          const resolved =
            typeof target === "string"
              ? path.posix.normalize(path.posix.join(path.posix.dirname(name), target))
              : ""
          if (
            !target ||
            target.startsWith("/") ||
            target.includes("\\") ||
            !resolved.startsWith("node_modules/") ||
            /[\p{Cc}]/u.test(target)
          )
            throw new Error("unsafe_dependency_link")
          links.set(name, target)
          pack.entry({ name, type: "symlink", linkname: target, mode: 0o777 })
        } else if (header.type === "file") {
          total += header.size
          if (header.size > 32 * 1024 * 1024 || total > 192 * 1024 * 1024)
            throw new Error("dependency_export_limit")
          const content = []
          let size = 0
          for await (const chunk of stream) {
            size += chunk.length
            if (size > header.size) throw new Error("dependency_export_limit")
            content.push(chunk)
          }
          if (size !== header.size) throw new Error("dependency_export_size")
          pack.entry(
            { name, mode: header.mode & 0o111 ? 0o755 : 0o644, size },
            Buffer.concat(content),
          )
          next()
          return
        } else throw new Error("unsupported_dependency_file")
        stream.resume()
        next()
      })().catch((error) => {
        stream.resume()
        extract.destroy(error)
      })
    })
  })
  extract.end(bytes)
  await completed
  for (const name of seen) {
    const parts = name.split("/")
    for (let at = 1; at < parts.length; at++) {
      if (links.has(parts.slice(0, at).join("/"))) throw new Error("unsafe_dependency_link_parent")
    }
  }
  for (const [name, target] of links) {
    const segments = [...name.split("/").slice(0, -1), ...target.split("/")]
    const resolved = []
    let followed = 0
    while (segments.length) {
      const segment = segments.shift()
      if (!segment || segment === ".") continue
      if (segment === "..") {
        if (resolved.length <= 1) throw new Error("unsafe_dependency_link_escape")
        resolved.pop()
        continue
      }
      resolved.push(segment)
      const link = links.get(resolved.join("/"))
      if (link !== undefined) {
        if (++followed > 40) throw new Error("unsafe_dependency_link_cycle")
        resolved.pop()
        segments.unshift(...link.split("/"))
      }
    }
    if (resolved[0] !== "node_modules" || !seen.has(resolved.join("/")))
      throw new Error("unsafe_dependency_link_target")
  }
  pack.finalize()
  await collect
  return Buffer.concat(chunks)
}

let container
let volume
try {
  const manifestBytes = await approvedFile("package.json")
  const lockBytes = await approvedFile("package-lock.json")
  const dependencies = approvedDependencies(JSON.parse(lockBytes), JSON.parse(manifestBytes))
  // Require the pinned base to be present. Never pull an image supplied by repository input.
  await command(["image", "inspect", baseDigest])
  await command(
    ["build", "--pull=false", "--network=default", "--tag", baseTag, path.join(root, "worker")],
    { report: true },
  )
  const base = (await command(["image", "inspect", "--format", "{{.Id}}", baseTag]))
    .toString()
    .trim()
  if (!/^sha256:[a-f0-9]{64}$/.test(base)) throw new Error("invalid_base_identity")
  container = `reina-prepare-${randomUUID()}`
  volume = `${container}-workspace`
  await command([
    "volume",
    "create",
    "--driver=local",
    "--label=io.reina.preparation=true",
    "--opt=type=tmpfs",
    "--opt=device=tmpfs",
    "--opt=o=size=256m,uid=1000,gid=1000,mode=0700,nosuid,nodev",
    volume,
  ])
  await command([
    "create",
    "--pull=never",
    `--name=${container}`,
    "--label=io.reina.preparation=true",
    "--network=none",
    "--read-only",
    "--user=1000:1000",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--cpus=1",
    "--memory=2g",
    "--memory-swap=2g",
    "--pids-limit=128",
    "--shm-size=1m",
    "--cgroupns=private",
    "--ulimit=nofile=256:256",
    "--mount",
    `type=volume,source=${volume},target=/workspace,volume-nocopy`,
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864,uid=1000,gid=1000,mode=0700",
    "--env=REINA_PHASE=prepare",
    "--env=HOME=/tmp/home",
    ...[
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
    ].map((name) => `--env=${name}=`),
    "--workdir=/workspace",
    base,
  ])
  await command(["start", container])
  await command(["exec", container, "node", "/opt/reina/ready.mjs"])
  await command(["exec", container, "node", "/opt/reina/probe.mjs"])
  await importFiles(container, "workspace", [
    ["package.json", manifestBytes],
    ["package-lock.json", lockBytes],
  ])
  const budget = { bytes: 0 }
  for (const [url, integrity] of dependencies) {
    const content = await download(url, integrity, budget)
    await importFiles(container, "dependency", [["dependency.tgz", content]])
    await command(["exec", container, "node", "/opt/reina/prepare.mjs", "cache"], {
      timeout: 130_000,
    })
  }
  await command(["exec", container, "node", "/opt/reina/prepare.mjs", "install"], {
    timeout: 130_000,
  })
  await command(["pause", container])
  const dependenciesTar = await sanitizeDependencies(
    await command(["cp", `${container}:/workspace/node_modules`, "-"], {
      limit: 224 * 1024 * 1024,
    }),
  )
  const lockHash = `sha256:${createHash("sha256").update(lockBytes).digest("hex")}`
  const manifestHash = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`
  const dockerfile = Buffer.from(
    `FROM ${baseTag}\nADD deps.tar /opt/deps/\nLABEL io.reina.dependency-lock="${lockHash}" io.reina.package-manifest="${manifestHash}"\n`,
  )
  await command(["build", "--pull=false", "--network=none", "--tag", tag, "-"], {
    input: await archive([
      ["Dockerfile", dockerfile],
      ["deps.tar", dependenciesTar],
    ]),
    report: true,
  })
  process.stdout.write((await command(["image", "inspect", "--format", "{{.Id}}", tag])).toString())
} catch (error) {
  const reason =
    error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message)
      ? error.message
      : "worker_preparation_failed"
  process.stderr.write(`${reason}\n`)
  process.exitCode = 1
} finally {
  if (container) {
    try {
      await command(["rm", "--force", "--volumes", container], { timeout: 15_000 })
    } catch {
      process.stderr.write("preparation_cleanup_failed\n")
      process.exitCode = 1
    }
  }
  if (volume) {
    try {
      await command(["volume", "rm", volume], { timeout: 15_000 })
    } catch {
      process.stderr.write("preparation_volume_cleanup_failed\n")
      process.exitCode = 1
    }
  }
}
