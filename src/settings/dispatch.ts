import picomatch from "picomatch"
import { z } from "zod"

const pinnedImage =
  /^(?:sha256:[a-f0-9]{64}|(?:[a-z0-9.-]+(?::[0-9]{1,5})\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64})$/

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
const commands = z
  .array(argv)
  .min(1)
  .max(8)
  .refine((value) => JSON.stringify(value).length <= 65_536)
const numericId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const owner = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/)
export const repositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/)
  .refine((value) => value !== "." && value !== ".." && value.trim() === value)

export const repositorySlugSchema = z
  .string()
  .max(140)
  .refine((value) => {
    const parts = value.split("/")
    return (
      parts.length === 2 &&
      owner.safeParse(parts[0]).success &&
      repositoryNameSchema.safeParse(parts[1]).success
    )
  })

/** Complete trusted settings. Do not return this object from the management API. */
export const dispatchSettingsSchema = z.strictObject({
  appId: numericId,
  webhookSecret: z
    .string()
    .min(32)
    .max(4_096)
    .refine((value) => value.trim() === value && !/[\p{Cc}]/u.test(value)),
  repository: z.strictObject({
    owner,
    name: repositoryNameSchema,
    id: numericId,
    installationId: numericId,
  }),
  image: z.string().max(512).regex(pinnedImage),
  allowedPaths: patterns,
  // Operators must include the repository's security and deployment domains.
  forbiddenPaths: patterns,
  commands,
  scanIntervalMs: z.number().int().min(60_000).max(86_400_000),
  maxIssuesPerScan: z.number().int().min(1).max(10),
  maxConcurrentJobs: z.literal(1),
  agentTimeoutMs: z.number().int().min(1_000).max(600_000),
  maxChangedFiles: z.number().int().min(1).max(10),
  maxPatchBytes: z.number().int().min(1).max(65_536),
})

const fields = dispatchSettingsSchema.shape
export const dispatchInputSchema = dispatchSettingsSchema.extend({
  webhookSecret: fields.webhookSecret.optional(),
  allowedPaths: fields.allowedPaths.default(["README.md", "docs/**", "src/**", "tests/**"]),
  commands: fields.commands.default([["npm", "run", "ci"]]),
  scanIntervalMs: fields.scanIntervalMs.default(900_000),
  maxIssuesPerScan: fields.maxIssuesPerScan.default(10),
  maxConcurrentJobs: fields.maxConcurrentJobs.default(1),
  agentTimeoutMs: fields.agentTimeoutMs.default(600_000),
  maxChangedFiles: fields.maxChangedFiles.default(10),
  maxPatchBytes: fields.maxPatchBytes.default(65_536),
})

export type DispatchSettings = z.infer<typeof dispatchSettingsSchema>
export type DispatchInput = z.input<typeof dispatchInputSchema>
export type DispatchStatus = Omit<DispatchSettings, "webhookSecret"> & {
  webhookSecretConfigured: boolean
}
