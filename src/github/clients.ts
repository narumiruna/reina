import { type Probot, ProbotOctokit } from "probot"
import { z } from "zod"
import type { Boundaries } from "../jobs/orchestrator.js"
import type { Config } from "../types.js"
import { Publisher } from "./publisher.js"
import { errorStatus, GitHub, GitHubDeferred, GitHubError, rateLimit } from "./scanner.js"

export const LimitedOctokit = ProbotOctokit.defaults({
  throttle: { enabled: false },
  retry: { enabled: false },
})

const installation = z.object({
  token: z.string().min(1),
  tokenType: z.literal("installation"),
  installationId: z.number().int().positive(),
  repositoryIds: z.array(z.number().int().positive()),
  expiresAt: z.string(),
  permissions: z.record(z.string(), z.string()),
})

// Scope is requested per auth call. Auth-strategy defaults alone do not restrict token permissions.
export async function installationClient(app: Probot, config: Config, write: boolean) {
  const root = await app.auth()
  const permissions: Record<string, string> = {
    metadata: "read",
    contents: write ? "write" : "read",
    issues: write ? "write" : "read",
    pull_requests: write ? "write" : "read",
  }
  let result: unknown
  try {
    result = await root.auth({
      type: "installation",
      installationId: config.repository.installationId,
      repositoryIds: [config.repository.id],
      permissions,
      refresh: true,
    })
  } catch (error) {
    const retryAt = rateLimit(error)
    const status = errorStatus(error)
    if (retryAt !== undefined || status === undefined || status >= 500 || status === 408) {
      throw new GitHubDeferred("github_auth_unavailable", retryAt ?? Date.now() + 60_000)
    }
    throw new GitHubError("github_auth_rejected", status)
  }
  const parsed = installation.safeParse(result)
  if (!parsed.success) throw new Error("installation_token_invalid")
  const auth = parsed.data
  if (
    auth.installationId !== config.repository.installationId ||
    auth.repositoryIds.length !== 1 ||
    auth.repositoryIds[0] !== config.repository.id ||
    !Number.isFinite(Date.parse(auth.expiresAt)) ||
    Date.parse(auth.expiresAt) < Date.now() + 900_000 ||
    Object.entries(permissions).some(([scope, level]) => auth.permissions[scope] !== level) ||
    Object.keys(auth.permissions).some((scope) => !(scope in permissions))
  ) {
    throw new Error("installation_scope_invalid")
  }
  return { client: new LimitedOctokit({ auth: { token: auth.token }, log: app.log }), auth }
}

export function boundaryFactory(
  app: Probot,
  config: Config,
  botId: number,
): () => Promise<Boundaries> {
  let cached: { boundaries: Boundaries; until: number } | undefined
  return async () => {
    if (cached && cached.until > Date.now()) return cached.boundaries
    const read = await installationClient(app, config, false)
    const write = await installationClient(app, config, true)
    const boundaries = {
      github: new GitHub(read.client, config.repository, botId, read.auth),
      publisher: new Publisher(write.client, config.repository, botId, write.auth),
    }
    cached = {
      boundaries,
      until: Math.min(Date.parse(read.auth.expiresAt), Date.parse(write.auth.expiresAt)) - 900_000,
    }
    return boundaries
  }
}
