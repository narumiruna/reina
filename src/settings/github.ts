import { z } from "zod"
import { dispatchSettingsSchema } from "./dispatch.js"

const fields = dispatchSettingsSchema.shape

/** Complete trusted settings. Never return these secrets from the management API. */
export const gitHubAppSettingsSchema = z.strictObject({
  appId: fields.appId,
  clientId: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,100}$/)
    .refine((value) => value.trim() === value),
  slug: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/)
    .refine((value) => value.trim() === value),
  clientSecret: z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => value.trim() === value && !/[\p{Cc}]/u.test(value)),
  webhookSecret: fields.webhookSecret,
})

/** Verified repository selection and GitHub user identity. Contains no tokens. */
export const gitHubConnectionSchema = z.strictObject({
  appId: fields.appId,
  repository: fields.repository,
  connectedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  user: z.strictObject({
    id: fields.appId,
    login: fields.repository.shape.owner.refine((value) => value.trim() === value),
  }),
})

export type GitHubAppSettings = z.infer<typeof gitHubAppSettingsSchema>
export type GitHubAppStatus = Omit<GitHubAppSettings, "clientSecret" | "webhookSecret"> & {
  clientSecretConfigured: boolean
  webhookSecretConfigured: boolean
}
export type GitHubConnection = z.infer<typeof gitHubConnectionSchema>
