import { z } from "zod"
import { privateStateDirectory } from "../config.js"
import type { AuthOptions } from "./auth.js"
import { groupNamesSchema } from "./groups.js"

function publicOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    )
  } catch {
    return false
  }
}
const safeText = z
  .string()
  .max(4096)
  .refine((value) => value.trim() === value && !/[\p{Cc}]/u.test(value))
const schema = z.object({
  REINA_STATE_DIR: z.string().refine(privateStateDirectory),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  PUBLIC_URL: z.string().refine(publicOrigin).default("https://reina.narumi.dev"),
  PORT: z
    .string()
    .regex(/^[1-9]\d*$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535))
    .prefault("36816"),
  OIDC_ISSUER: safeText
    .refine((value) => {
      if (!value) return true
      try {
        const url = new URL(value)
        return (
          url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
        )
      } catch {
        return false
      }
    })
    .default(""),
  OIDC_CLIENT_ID: safeText.default(""),
  OIDC_CLIENT_SECRET: safeText.default(""),
  OIDC_ALLOWED_GROUPS: safeText
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((group) => group.trim())
        .filter(Boolean),
    )
    .pipe(groupNamesSchema)
    .transform((groups) => groups.sort()),
})
export interface WebConfig {
  stateDir: string
  encryptionKey: string
  port: number
  auth: AuthOptions
}
export function loadWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const result = schema.safeParse(env)
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))].sort()
    throw new Error(`Invalid web configuration fields: ${fields.join(", ")}`)
  }
  const value = result.data
  return {
    stateDir: value.REINA_STATE_DIR,
    encryptionKey: value.ENCRYPTION_KEY,
    port: value.PORT,
    auth: {
      origin: new URL(value.PUBLIC_URL).origin,
      issuer: value.OIDC_ISSUER,
      clientId: value.OIDC_CLIENT_ID,
      clientSecret: value.OIDC_CLIENT_SECRET,
      allowedGroups: value.OIDC_ALLOWED_GROUPS,
    },
  }
}
