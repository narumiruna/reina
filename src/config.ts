import { existsSync, lstatSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path"
import picomatch from "picomatch"
import { z } from "zod"
import type { ModelSelection } from "./settings/schema.js"
import type { Config } from "./types.js"

const integer = (min: number, max: number, fallback?: number) => {
  const schema = z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
  return fallback === undefined ? schema : schema.prefault(String(fallback))
}

const pinnedImage =
  /^(?:sha256:[a-f0-9]{64}|(?:[a-z0-9.-]+(?::[0-9]{1,5})\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64})$/

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

function validPattern(pattern: string): boolean {
  if (
    pattern.startsWith("!") ||
    pattern.startsWith("/") ||
    /[\\:()\p{Cc}\p{Cf}]/u.test(pattern) ||
    pattern
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || /[. ]$/.test(part))
  ) {
    return false
  }
  try {
    picomatch.makeRe(pattern, { nonegate: true, noext: true, strictBrackets: true })
    return true
  } catch {
    return false
  }
}

const patterns = z
  .array(z.string().min(1).max(256).refine(validPattern))
  .min(1)
  .max(64)
  .refine((values) => new Set(values.map((value) => value.toLowerCase())).size === values.length)
const argv = z
  .array(
    z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !/[\0\r\n]/.test(value)),
  )
  .min(1)
  .max(32)
const commands = z.array(argv).min(1).max(8)

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

const environmentSchema = z.strictObject({
  APP_ID: integer(1, Number.MAX_SAFE_INTEGER),
  WEBHOOK_SECRET: z
    .string()
    .min(32)
    .max(4_096)
    .refine((value) => value.trim() === value && !/[\p{Cc}]/u.test(value)),
  REINA_REPOSITORY: z
    .string()
    .max(140)
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/),
  REINA_REPOSITORY_ID: integer(1, Number.MAX_SAFE_INTEGER),
  REINA_INSTALLATION_ID: integer(1, Number.MAX_SAFE_INTEGER),
  REINA_STATE_DIR: z.string().min(1).max(4_096).refine(privateStateDirectory),
  REINA_WORKER_IMAGE: z.string().max(512).regex(pinnedImage),
  REINA_ALLOWED_PATHS: json(patterns, '["README.md","docs/**","src/**","tests/**"]'),
  // Operators must name the repository's security and deployment domains. Syntax checks
  // cannot establish that this list covers those domains.
  REINA_FORBIDDEN_PATHS: json(patterns),
  REINA_VERIFY_COMMANDS: json(commands, '[["npm","run","ci"]]'),
  REINA_SCAN_INTERVAL_MS: integer(60_000, 86_400_000, 900_000),
  REINA_MAX_ISSUES_PER_SCAN: integer(1, 10, 10),
  REINA_MAX_CONCURRENT_JOBS: integer(1, 1, 1),
  REINA_AGENT_TIMEOUT_MS: integer(1_000, 600_000, 600_000),
  REINA_MAX_CHANGED_FILES: integer(1, 10, 10),
  REINA_MAX_PATCH_BYTES: integer(1, 65_536, 65_536),
})

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Omit<Config, keyof ModelSelection> {
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
