import { existsSync, lstatSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import { z } from "zod"
import {
  type DispatchSettings,
  dispatchSettingsSchema,
  repositorySlugSchema,
} from "./settings/dispatch.js"
import type { ModelSelection } from "./settings/schema.js"
import type { Config } from "./types.js"

const integer = (validation: z.ZodType<number, number>, fallback?: number) => {
  const schema = z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(validation)
  return fallback === undefined ? schema : schema.prefault(String(fallback))
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function canonicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  if (parent === path) return path
  return join(canonicalPath(parent), parse(path).base)
}

export function privateStateDirectory(path: string): boolean {
  try {
    if (!isAbsolute(path) || path !== resolve(path) || path === parse(path).root) return false
    let checkout = realpathSync(process.cwd())
    for (let candidate = checkout; ; candidate = dirname(candidate)) {
      if (existsSync(join(candidate, ".git"))) {
        checkout = candidate
        break
      }
      if (candidate === dirname(candidate)) break
    }
    const state = canonicalPath(path)
    if (within(checkout, state) || within(state, checkout)) return false
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false
      if (process.getuid && stat.uid !== process.getuid()) return false
    }
    return true
  } catch {
    return false
  }
}

export const stateDirectorySchema = z.string().min(1).max(4_096).refine(privateStateDirectory)

function json<T extends z.ZodType>(schema: T, fallback?: string) {
  const value = z
    .string()
    .max(65_536)
    .transform((input, context) => {
      try {
        return JSON.parse(input) as unknown
      } catch {
        context.addIssue({ code: "custom", message: "Invalid JSON" })
        return z.NEVER
      }
    })
    .pipe(schema)
  return fallback === undefined ? value : value.prefault(fallback)
}

const fields = dispatchSettingsSchema.shape
const environmentSchema = z.strictObject({
  APP_ID: integer(fields.appId),
  WEBHOOK_SECRET: fields.webhookSecret,
  REINA_REPOSITORY: repositorySlugSchema,
  REINA_REPOSITORY_ID: integer(fields.repository.shape.id),
  REINA_INSTALLATION_ID: integer(fields.repository.shape.installationId),
  REINA_STATE_DIR: stateDirectorySchema,
  REINA_WORKER_IMAGE: fields.image,
  REINA_ALLOWED_PATHS: json(fields.allowedPaths, '["README.md","docs/**","src/**","tests/**"]'),
  REINA_FORBIDDEN_PATHS: json(fields.forbiddenPaths),
  REINA_VERIFY_COMMANDS: json(fields.commands, '[["npm","run","ci"]]'),
  REINA_SCAN_INTERVAL_MS: integer(fields.scanIntervalMs, 900_000),
  REINA_MAX_ISSUES_PER_SCAN: integer(fields.maxIssuesPerScan, 10),
  REINA_MAX_CONCURRENT_JOBS: integer(fields.maxConcurrentJobs, 1),
  REINA_AGENT_TIMEOUT_MS: integer(fields.agentTimeoutMs, 600_000),
  REINA_MAX_CHANGED_FILES: integer(fields.maxChangedFiles, 10),
  REINA_MAX_PATCH_BYTES: integer(fields.maxPatchBytes, 65_536),
})

/** Legacy environment settings, including credentials. Use only before settings are saved. */
export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): DispatchSettings & { stateDir: string } {
  // The host environment contains unrelated keys. Only this allowlist enters validation.
  const selected = Object.fromEntries(
    Object.keys(environmentSchema.shape).map((key) => [key, env[key]]),
  )
  const result = environmentSchema.safeParse(selected)
  const unknown = Object.keys(env).filter(
    (key) => key.startsWith("REINA_") && !(key in environmentSchema.shape),
  )
  if (!result.success || unknown.length > 0) {
    const fields = result.success
      ? []
      : result.error.issues.map((issue) => String(issue.path[0] ?? "environment"))
    // Do not include Zod input, JSON parse messages, or credential values in errors.
    throw new Error(
      `Invalid configuration fields: ${[...new Set([...fields, ...unknown])].sort().join(", ")}`,
    )
  }
  const value = result.data
  const [owner, name] = value.REINA_REPOSITORY.split("/")
  return {
    appId: value.APP_ID,
    webhookSecret: value.WEBHOOK_SECRET,
    repository: {
      owner,
      name,
      id: value.REINA_REPOSITORY_ID,
      installationId: value.REINA_INSTALLATION_ID,
    },
    stateDir: value.REINA_STATE_DIR,
    image: value.REINA_WORKER_IMAGE,
    allowedPaths: value.REINA_ALLOWED_PATHS,
    forbiddenPaths: value.REINA_FORBIDDEN_PATHS,
    commands: value.REINA_VERIFY_COMMANDS,
    scanIntervalMs: value.REINA_SCAN_INTERVAL_MS,
    maxIssuesPerScan: value.REINA_MAX_ISSUES_PER_SCAN,
    maxConcurrentJobs: 1,
    agentTimeoutMs: value.REINA_AGENT_TIMEOUT_MS,
    maxChangedFiles: value.REINA_MAX_CHANGED_FILES,
    maxPatchBytes: value.REINA_MAX_PATCH_BYTES,
  }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Omit<Config, keyof ModelSelection> {
  const { appId: _appId, webhookSecret: _webhookSecret, ...config } = loadRuntimeConfig(env)
  return config
}
