import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Probot } from "probot"
import { z } from "zod"
import type { Orchestrator, Work } from "./jobs/orchestrator.js"
import type { Config } from "./types.js"

const id = z.number().int().positive()
const envelope = z.object({
  action: z.string().max(64).optional(),
  installation: z.object({ id }).optional(),
  repository: z
    .object({
      id,
      name: z.string().max(100),
      owner: z.object({ login: z.string().max(100) }),
      default_branch: z.string().max(255).optional(),
    })
    .optional(),
  sender: z.object({ id, login: z.string().max(100), type: z.string().max(32) }).optional(),
  issue: z
    .object({ id, number: id, pull_request: z.unknown().transform(Boolean).optional() })
    .optional(),
  label: z.object({ name: z.string().max(100) }).optional(),
  comment: z.object({ user: z.object({ id }) }).optional(),
  ref: z.string().max(300).optional(),
  repositories_removed: z.array(z.object({ id })).max(1_000).optional(),
})

export function sanitizeWebhook(payload: unknown): unknown {
  return envelope.parse(payload)
}

export function webhookWork(
  name: string,
  payload: unknown,
  config: Config,
  botId: number,
): Work | undefined {
  const parsed = envelope.safeParse(payload)
  if (!parsed.success) return
  const data = parsed.data
  const repo = config.repository
  if (data.installation?.id !== repo.installationId) return
  if (name === "installation" && ["deleted", "suspend"].includes(data.action ?? "")) {
    return { kind: "invalidate", disable: true }
  }
  if (
    name === "installation_repositories" &&
    data.repositories_removed?.some((item) => item.id === repo.id)
  ) {
    return { kind: "invalidate", disable: true }
  }
  if (
    data.repository?.id !== repo.id ||
    data.repository.name.toLowerCase() !== repo.name.toLowerCase() ||
    data.repository.owner.login.toLowerCase() !== repo.owner.toLowerCase()
  )
    return
  if (name === "push" && data.ref?.startsWith("refs/heads/")) {
    return { kind: "invalidate", branch: data.ref.slice(11), disable: false }
  }
  if (
    name === "repository" &&
    ["edited", "deleted", "archived", "transferred"].includes(data.action ?? "")
  ) {
    return { kind: "invalidate", disable: data.action !== "edited" }
  }
  if (name === "pull_request") return { kind: "scan", reason: "pull_request_changed" }
  if (!["issues", "issue_comment"].includes(name) || !data.issue || data.issue.pull_request) return
  const action = data.action ?? ""
  // Projection updates cannot revoke a later proposal when GitHub delivers them out of order.
  if (
    name === "issues" &&
    data.sender?.id === botId &&
    ["labeled", "unlabeled"].includes(action) &&
    data.label?.name !== "bot:skip"
  )
    return
  if (name === "issue_comment" && data.comment?.user.id === botId) return
  if (
    name === "issues" &&
    !["opened", "edited", "reopened", "closed", "labeled", "unlabeled", "deleted"].includes(action)
  )
    return
  const label = data.label?.name
  const cancel =
    ["closed", "deleted"].includes(action) ||
    (action === "unlabeled" && label === "bot:approved") ||
    (action === "labeled" && label === "bot:skip")
  return {
    kind: "issue",
    ref: { ...repo, issueId: data.issue.id, number: data.issue.number },
    action,
    label,
    actor: data.sender,
    material: name === "issue_comment" || action === "edited" || action === "reopened",
    cancel,
  }
}

export function register(
  app: Probot,
  config: Config,
  orchestrator: Orchestrator,
  botId: number,
): void {
  app.onAny((context) => {
    const work = webhookWork(context.name, context.payload, config, botId)
    if (work) orchestrator.accept(context.id, work)
  })
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 1_048_576) throw new Error("payload_too_large")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

// Bound and sanitize input before Probot dispatch, so even library error logs cannot contain issue bodies.
export function httpServer(app: Probot) {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url === "/healthz" && req.method === "GET") {
      res.writeHead(200).end("ok")
      return
    }
    if (req.url !== "/api/github/webhooks" || req.method !== "POST") {
      res.writeHead(404).end()
      return
    }
    const delivery = req.headers["x-github-delivery"]
    const name = req.headers["x-github-event"]
    const signature = req.headers["x-hub-signature-256"]
    if (
      typeof delivery !== "string" ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(delivery) ||
      typeof name !== "string" ||
      !/^[a-z_]{1,64}$/.test(name) ||
      typeof signature !== "string"
    ) {
      res.writeHead(400).end()
      return
    }
    let raw: string
    try {
      raw = await body(req)
    } catch {
      res.writeHead(413).end()
      return
    }
    if (!(await app.webhooks.verify(raw, signature).catch(() => false))) {
      res.writeHead(401).end()
      return
    }
    let payload: unknown
    try {
      payload = sanitizeWebhook(JSON.parse(raw))
    } catch {
      res.writeHead(400).end()
      return
    }
    try {
      const event = { id: delivery, name, payload } as Parameters<Probot["receive"]>[0]
      await app.receive(event)
      res.writeHead(202).end()
    } catch {
      // Handlers perform only synchronous durable intake. A failed write must remain retryable by GitHub.
      res.writeHead(503).end()
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(503)
      res.end()
    })
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  return server
}
