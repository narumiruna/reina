import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type {
  AgentRuntime,
  Config,
  ExecutionResult,
  Snapshot,
  SourceFile,
  Verification,
} from "../types.js"
import { ARCHIVE_LIMIT, checkSnapshot, parseWorkspaceArchive } from "./archive.js"
import { ModelGateway } from "./model-gateway.js"
import { PI_VERSION, PiStream, piArguments, trustedModels, trustedSettings } from "./pi.js"

interface CommandOptions {
  input?: Buffer
  signal?: AbortSignal
  timeoutMs?: number
  limit?: number
  stdout?: (chunk: Buffer) => void
  stderr?: (chunk: Buffer) => void
  terminate?: () => Promise<void>
}
interface CommandResult {
  exitCode: number
  stdout: Buffer
  durationMs: number
}

/** The only host subprocess is the Docker client. No shell or host Pi fallback exists. */
export async function dockerCommand(
  argv: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  if (options.signal?.aborted) throw new Error("runtime_cancelled")
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn("docker", argv, { stdio: ["pipe", "pipe", "pipe"], env: process.env })
    let failure: Error | undefined
    let outputBytes = 0
    let errorBytes = 0
    const output: Buffer[] = []
    let forced: NodeJS.Timeout | undefined
    const fail = (error: Error) => {
      if (failure) return
      failure = error
      if (options.terminate) void options.terminate().catch(() => {})
      else child.kill("SIGKILL")
      forced = setTimeout(() => {
        child.kill("SIGKILL")
      }, 15_000)
      forced.unref()
    }
    const cancelled = () => {
      fail(new Error("runtime_cancelled"))
    }
    options.signal?.addEventListener("abort", cancelled, { once: true })
    const timer = setTimeout(() => {
      fail(new Error("runtime_timeout"))
    }, options.timeoutMs ?? 30_000)
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return // Keep draining until the entire container has stopped.
      try {
        if (options.stdout) options.stdout(chunk)
        else {
          outputBytes += chunk.length
          if (outputBytes > (options.limit ?? 128 * 1024)) throw new Error("docker_stdout_limit")
          output.push(Buffer.from(chunk))
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error("runtime_stream_error"))
      }
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return
      try {
        if (options.stderr) options.stderr(chunk)
        else {
          errorBytes += chunk.length
          if (errorBytes > 64 * 1024) throw new Error("docker_stderr_limit")
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error("runtime_stream_error"))
      }
    })
    child.stdin.on("error", () => {})
    child.once("error", () => {
      fail(new Error("docker_unavailable"))
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      clearTimeout(forced)
      options.signal?.removeEventListener("abort", cancelled)
      if (failure) reject(failure)
      else
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(output),
          durationMs: Math.round(performance.now() - started),
        })
    })
    child.stdin.end(options.input)
    if (options.signal?.aborted) cancelled()
  })
}

export function containerArguments(
  image: string,
  name: string,
  owner: string,
  phase: string,
  socket?: string,
  snapshot?: string,
): string[] {
  const argv = [
    "create",
    "--pull=never",
    `--name=${name}`,
    "--label=io.reina.managed=true",
    `--label=io.reina.owner=${owner}`,
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
    "--workdir=/workspace",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=67108864,uid=1000,gid=1000,mode=0700",
    "--env=HOME=/tmp/home",
    "--env=XDG_CONFIG_HOME=/tmp/home/.config",
    "--env=PI_CODING_AGENT_DIR=/tmp/reina-agent",
    "--env=PI_CODING_AGENT_SESSION_DIR=/tmp/sessions",
    "--env=PI_OFFLINE=1",
    "--env=PI_SKIP_VERSION_CHECK=1",
    "--env=PI_TELEMETRY=0",
    `--env=REINA_PHASE=${phase}`,
    "--env=npm_config_ignore_scripts=true",
    "--env=npm_config_offline=true",
    // Docker can otherwise inject proxy credentials from the host client configuration.
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
  ]
  if (snapshot)
    argv.push(
      "--mount",
      `type=bind,src=${snapshot},dst=/workspace,readonly,bind-recursive=disabled`,
    )
  else argv.push("--mount", `type=volume,source=${name}-workspace,target=/workspace,volume-nocopy`)
  if (socket) argv.push("--mount", `type=bind,src=${socket},dst=/run/reina-model.sock,readonly`)
  argv.push("--entrypoint=/usr/local/bin/node", image, "/opt/reina/bridge.mjs")
  return argv
}

export function imageMatchesReference(
  reference: string,
  image: { Id: string; RepoDigests?: string[] },
): boolean {
  if (/^sha256:[a-f0-9]{64}$/.test(reference)) return image.Id === reference
  if (!/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(reference)) return false
  const normalize = (value: string) => {
    const [raw, digest] = value.split("@")
    let repository = raw.replace(/:[^/:]+$/, "")
    const first = repository.split("/")[0]
    if (!repository.includes("/")) repository = `docker.io/library/${repository}`
    else if (!first.includes(".") && !first.includes(":") && first !== "localhost")
      repository = `docker.io/${repository}`
    if (repository.startsWith("docker.io/") && repository.split("/").length === 2)
      repository = repository.replace("docker.io/", "docker.io/library/")
    return `${repository}@${digest}`
  }
  return image.RepoDigests?.some((value) => normalize(value) === normalize(reference)) ?? false
}

interface JobContainer {
  id: string
  directory: string
  volume?: string
  gateway?: ModelGateway
}

export class DockerRuntime implements AgentRuntime {
  private readonly owner: string
  private readonly containers = new Set<string>()
  private readonly gateways = new Set<ModelGateway>()
  private readonly removals = new Map<string, Promise<void>>()
  private readonly volumeRemovals = new Map<string, Promise<void>>()
  private image: string | undefined
  private lockHash: string | undefined
  private packageHash: string | undefined

  constructor(private readonly config: Config) {
    this.owner = createHash("sha256")
      .update(`${config.stateDir}:${config.repository.id}`)
      .digest("hex")
      .slice(0, 24)
    piArguments(config.model, "triage")
  }

  private async checked(argv: string[], options?: CommandOptions): Promise<CommandResult> {
    const result = await dockerCommand(argv, options)
    if (result.exitCode !== 0) throw new Error("docker_operation_failed")
    return result
  }

  async preflight(): Promise<void> {
    if (this.image) return
    const byId = /^sha256:[a-f0-9]{64}$/.test(this.config.image)
    const byDigest = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(this.config.image)
    if (!byId && !byDigest) throw new Error("worker_image_not_pinned")
    const info = JSON.parse(
      (await this.checked(["info", "--format", "{{json .}}"])).stdout.toString(),
    )
    if (
      info.OSType !== "linux" ||
      !info.SecurityOptions?.some((value: string) => value.includes("name=seccomp,profile=builtin"))
    )
      throw new Error("docker_seccomp_unavailable")
    const [image] = JSON.parse(
      (await this.checked(["image", "inspect", this.config.image])).stdout.toString(),
    )
    if (!imageMatchesReference(this.config.image, image))
      throw new Error("worker_image_identity_mismatch")
    const labels = image.Config?.Labels ?? {}
    if (
      !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
      labels["io.reina.pi-version"] !== PI_VERSION ||
      labels["io.reina.runtime"] !== "1" ||
      !/^sha256:[a-f0-9]{64}$/.test(labels["io.reina.dependency-lock"] ?? "") ||
      !/^sha256:[a-f0-9]{64}$/.test(labels["io.reina.package-manifest"] ?? "")
    )
      throw new Error("worker_image_not_prepared")
    await this.cleanup()
    this.image = image.Id
    this.lockHash = labels["io.reina.dependency-lock"]
    this.packageHash = labels["io.reina.package-manifest"]
    let container: JobContainer | undefined
    try {
      container = await this.create(undefined, "verify")
      const probe = await this.exec(container.id, ["/usr/local/bin/node", "/opt/reina/probe.mjs"])
      if (probe.exitCode !== 0 || probe.stdout.toString() !== "controls_verified\n")
        throw new Error("runtime_controls_unavailable")
      const version = await this.exec(container.id, [
        "/usr/local/bin/node",
        "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
        "--version",
      ])
      if (version.exitCode !== 0 || version.stdout.toString().trim() !== PI_VERSION)
        throw new Error("worker_pi_version_mismatch")
      await this.remove(container)
      container = undefined
      container = await this.create(undefined, "code")
      // No model call: a 401 proves the mounted socket reaches the narrow host gateway.
      const socket = await this.exec(container.id, [
        "/usr/local/bin/node",
        "--input-type=module",
        "-e",
        "import http from 'node:http'; const req=http.request('http://127.0.0.1:3210/v1/chat/completions',{method:'POST'},res=>{res.resume();res.on('end',()=>process.exit(res.statusCode===401?0:1));});req.on('error',()=>process.exit(1));req.end('{}');",
      ])
      if (socket.exitCode !== 0) throw new Error("runtime_socket_unavailable")
      await this.importFiles(container.id, "workspace", {
        "runtime-probe.txt": { mode: "100644", content: Buffer.from("frozen_export_verified") },
      })
      await this.checked(["pause", container.id])
      const exported = await this.checked(["cp", `${container.id}:/workspace/.`, "-"], {
        limit: 16 * 1024,
      })
      const files = await parseWorkspaceArchive(exported.stdout)
      if (files["runtime-probe.txt"]?.content.toString() !== "frozen_export_verified")
        throw new Error("runtime_frozen_export_unavailable")
    } catch (error) {
      this.image = undefined
      throw error
    } finally {
      if (container) await this.remove(container)
    }
  }

  private assertSnapshot(snapshot: Snapshot): void {
    if (!this.image) throw new Error("runtime_preflight_required")
    checkSnapshot(snapshot)
    const lock = snapshot.files["package-lock.json"]
    const manifest = snapshot.files["package.json"]
    if (
      !lock ||
      !manifest ||
      `sha256:${createHash("sha256").update(lock.content).digest("hex")}` !== this.lockHash ||
      `sha256:${createHash("sha256").update(manifest.content).digest("hex")}` !== this.packageHash
    )
      throw new Error("worker_dependency_fingerprint_mismatch")
  }

  private async create(
    snapshot: Snapshot | undefined,
    phase: "triage" | "code" | "verify",
    signal?: AbortSignal,
  ): Promise<JobContainer> {
    if (signal?.aborted) throw new Error("runtime_cancelled")
    const directory = await mkdtemp(path.join(os.tmpdir(), `reina-job-${this.owner}-`))
    await chmod(directory, 0o700)
    const container: JobContainer = { id: `reina-${randomUUID()}`, directory }
    this.containers.add(container.id)
    try {
      if (phase !== "verify") {
        const lifetimeMs =
          phase === "triage" ? 120_000 : Math.min(600_000, this.config.agentTimeoutMs)
        container.gateway = new ModelGateway(this.config, path.join(directory, "model.sock"), {
          requests: phase === "triage" ? 8 : 24,
          lifetimeMs,
        })
        this.gateways.add(container.gateway)
        await container.gateway.listen()
      }
      let source: string | undefined
      if (snapshot && phase === "triage") {
        source = path.join(directory, "snapshot")
        await mkdir(source, { mode: 0o755 })
        for (const [name, file] of Object.entries(snapshot.files)) {
          await mkdir(path.dirname(path.join(source, name)), { recursive: true, mode: 0o755 })
          await writeFile(path.join(source, name), file.content, {
            mode: file.mode === "100755" ? 0o555 : 0o444,
            flag: "wx",
          })
        }
      }
      if (!source) {
        container.volume = `${container.id}-workspace`
        await this.checked(
          [
            "volume",
            "create",
            "--driver=local",
            `--label=io.reina.owner=${this.owner}`,
            "--label=io.reina.managed=true",
            "--opt=type=tmpfs",
            "--opt=device=tmpfs",
            "--opt=o=size=256m,uid=1000,gid=1000,mode=0700,nosuid,nodev",
            container.volume,
          ],
          { signal },
        )
      }
      await this.checked(
        containerArguments(
          this.image as string,
          container.id,
          this.owner,
          phase,
          container.gateway?.socketPath,
          source,
        ),
        { signal },
      )
      await this.checked(["start", container.id], { signal })
      const ready = await this.exec(container.id, ["/usr/local/bin/node", "/opt/reina/ready.mjs"], {
        signal,
        timeoutMs: 10_000,
      })
      if (ready.exitCode !== 0) throw new Error("worker_start_failed")
      if (snapshot && phase !== "triage")
        await this.importFiles(container.id, "workspace", snapshot.files, signal)
      if (container.gateway) {
        const files: Record<string, SourceFile> = {
          "settings.json": {
            mode: "100644",
            content: Buffer.from(JSON.stringify(trustedSettings())),
          },
          "models.json": {
            mode: "100644",
            content: Buffer.from(
              JSON.stringify(trustedModels(this.config.model, container.gateway.capability)),
            ),
          },
        }
        await this.importFiles(container.id, "config", files, signal)
      }
      return container
    } catch (error) {
      await this.remove(container)
      throw error
    }
  }

  private async importFiles(
    id: string,
    kind: "workspace" | "config",
    files: Record<string, SourceFile>,
    signal?: AbortSignal,
  ): Promise<void> {
    const input = Buffer.from(
      JSON.stringify(
        Object.entries(files).map(([name, file]) => ({
          path: name,
          mode: file.mode,
          content: file.content.toString("base64"),
        })),
      ),
    )
    const result = await this.exec(id, ["/usr/local/bin/node", "/opt/reina/import.mjs", kind], {
      input,
      signal,
    })
    if (result.exitCode !== 0) throw new Error("worker_import_failed")
  }

  private exec(id: string, argv: string[], options: CommandOptions = {}): Promise<CommandResult> {
    return dockerCommand(
      ["exec", "--interactive", "--workdir=/workspace", "--user=1000:1000", id, ...argv],
      { ...options, terminate: () => this.destroy(id) },
    )
  }

  private destroy(id: string): Promise<void> {
    const pending = this.removals.get(id)
    if (pending) return pending
    const removal = (async () => {
      const result = await dockerCommand(["rm", "--force", "--volumes", id], { timeoutMs: 15_000 })
      if (result.exitCode !== 0) {
        const existing = await this.checked([
          "ps",
          "-aq",
          "--no-trunc",
          "--filter",
          `name=^/${id}$`,
        ])
        if (existing.stdout.length) throw new Error("container_cleanup_failed")
      }
      this.containers.delete(id)
    })().finally(() => {
      this.removals.delete(id)
    })
    this.removals.set(id, removal)
    return removal
  }

  private destroyVolume(name: string): Promise<void> {
    const pending = this.volumeRemovals.get(name)
    if (pending) return pending
    const removal = (async () => {
      const result = await dockerCommand(["volume", "rm", name])
      if (result.exitCode !== 0) {
        const existing = await this.checked([
          "volume",
          "ls",
          "--quiet",
          "--filter",
          `name=^${name}$`,
        ])
        if (existing.stdout.length) throw new Error("volume_cleanup_failed")
      }
    })().finally(() => {
      this.volumeRemovals.delete(name)
    })
    this.volumeRemovals.set(name, removal)
    return removal
  }

  private async remove(container: JobContainer): Promise<void> {
    try {
      if (container.gateway) {
        await container.gateway.close()
        this.gateways.delete(container.gateway)
      }
    } finally {
      try {
        await this.destroy(container.id)
        if (container.volume) await this.destroyVolume(container.volume)
      } finally {
        await rm(container.directory, { recursive: true, force: true })
      }
    }
  }

  private async withDeadline<T>(
    signal: AbortSignal,
    milliseconds: number,
    run: (bounded: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(milliseconds)
    const bounded = AbortSignal.any([signal, timeout])
    try {
      const result = await run(bounded)
      if (bounded.aborted) throw new Error("runtime_cancelled")
      return result
    } catch (error) {
      if (timeout.aborted && !signal.aborted) throw new Error("runtime_timeout")
      throw error
    }
  }

  private async invoke(
    snapshot: Snapshot,
    prompt: string,
    phase: "triage" | "code",
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    this.assertSnapshot(snapshot)
    if (Buffer.byteLength(prompt) > 1024 * 1024) throw new Error("task_input_limit")
    return this.withDeadline(
      signal,
      phase === "triage" ? 120_000 : Math.min(600_000, this.config.agentTimeoutMs),
      async (signal) => {
        const container = await this.create(snapshot, phase, signal)
        try {
          const parser = new PiStream()
          const result = await this.exec(container.id, piArguments(this.config.model, phase), {
            input: Buffer.from(prompt),
            signal,
            timeoutMs: phase === "triage" ? 120_000 : Math.min(600_000, this.config.agentTimeoutMs),
            stdout: (chunk) => parser.stdout(chunk),
            stderr: (chunk) => parser.stderr(chunk),
          })
          const finalText = parser.finish(result.exitCode)
          container.gateway?.revoke()
          if (signal.aborted) throw new Error("runtime_cancelled")
          if (phase === "triage") {
            let decision: unknown
            try {
              decision = JSON.parse(finalText)
            } catch {
              throw new Error("triage_invalid_json")
            }
            if (!decision || typeof decision !== "object" || Array.isArray(decision))
              throw new Error("triage_invalid_json")
            return { finalText, files: {} }
          }
          await this.checked(["pause", container.id], {
            signal,
            terminate: () => this.destroy(container.id),
          })
          const frozen = JSON.parse(
            (
              await this.checked(["inspect", "--format", "{{json .State}}", container.id], {
                signal,
              })
            ).stdout.toString(),
          )
          if (!frozen.Paused) throw new Error("container_freeze_failed")
          const archive = await this.checked(["cp", `${container.id}:/workspace/.`, "-"], {
            signal,
            limit: ARCHIVE_LIMIT,
            terminate: () => this.destroy(container.id),
          })
          const files = await parseWorkspaceArchive(archive.stdout)
          return { finalText, files }
        } finally {
          await this.remove(container)
        }
      },
    )
  }

  async triage(snapshot: Snapshot, prompt: string, signal: AbortSignal): Promise<string> {
    return (await this.invoke(snapshot, prompt, "triage", signal)).finalText
  }

  code(snapshot: Snapshot, prompt: string, signal: AbortSignal): Promise<ExecutionResult> {
    return this.invoke(snapshot, prompt, "code", signal)
  }

  async verify(
    snapshot: Snapshot,
    commands: string[][],
    signal: AbortSignal,
  ): Promise<Verification[]> {
    this.assertSnapshot(snapshot)
    if (
      !commands.length ||
      JSON.stringify(commands) !== JSON.stringify(this.config.commands) ||
      commands.some(
        (argv) => !argv.length || argv.some((arg) => typeof arg !== "string" || arg.includes("\0")),
      )
    )
      throw new Error("verification_commands_not_approved")
    return this.withDeadline(signal, 180_000, async (signal) => {
      const deadline = performance.now() + 180_000
      const container = await this.create(snapshot, "verify", signal)
      const results: Verification[] = []
      try {
        for (const argv of commands) {
          const timeoutMs = deadline - performance.now()
          if (timeoutMs <= 0) throw new Error("verification_timeout")
          const result = await this.exec(container.id, argv, {
            signal,
            timeoutMs,
            limit: 64 * 1024,
          })
          results.push({
            argv: [...argv],
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            image: this.config.image,
          })
          if (result.exitCode !== 0) break
        }
        return results
      } finally {
        await this.remove(container)
      }
    })
  }

  async cleanup(): Promise<void> {
    for (const gateway of this.gateways) await gateway.close()
    this.gateways.clear()
    const result = await this.checked([
      "ps",
      "-aq",
      "--filter",
      `label=io.reina.owner=${this.owner}`,
    ])
    const ids = new Set([
      ...this.containers,
      ...result.stdout.toString().trim().split("\n").filter(Boolean),
    ])
    for (const id of ids) await this.destroy(id)
    const volumes = await this.checked([
      "volume",
      "ls",
      "--quiet",
      "--filter",
      `label=io.reina.owner=${this.owner}`,
    ])
    for (const volume of volumes.stdout.toString().trim().split("\n").filter(Boolean))
      await this.destroyVolume(volume)
    const prefix = `reina-job-${this.owner}-`
    for (const name of await readdir(os.tmpdir())) {
      if (!name.startsWith(prefix) || name.length !== prefix.length + 6) continue
      const directory = path.join(os.tmpdir(), name)
      const stat = await lstat(directory).catch(() => undefined)
      if (
        stat?.isDirectory() &&
        (stat.mode & 0o077) === 0 &&
        (!process.getuid || stat.uid === process.getuid())
      ) {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
}
