import { createHash } from "node:crypto"
import picomatch from "picomatch"
import type { Config, Issue, Proposal, Snapshot, TriageDecision } from "../types.js"
import { triageSchema } from "./schema.js"

const POLICY_REVISION = "reina-mvp-1"
const DAY_MS = 86_400_000
const PROTECTED_DIRECTORIES = new Set([
  ".git",
  ".github",
  ".pi",
  ".agents",
  ".claude",
  ".cursor",
  ".devcontainer",
  ".husky",
  ".vscode",
  ".idea",
  ".ssh",
  ".aws",
  ".config",
  ".docker",
  ".yarn",
  "node_modules",
  "auth",
  "authentication",
  "authorization",
  "security",
  "deploy",
  "deployment",
  "infra",
  "infrastructure",
  "terraform",
  "kubernetes",
  "k8s",
])
const PROTECTED_PATTERNS = [
  "**/.env*",
  "**/*.{pem,key,p12,pfx,p8,jks,keystore}",
  "**/{.netrc,.pgpass,.htpasswd,.git-credentials,service-account*.json}",
  "**/{AGENTS,CLAUDE,GEMINI,INSTRUCTIONS,REINA}*.md",
  "**/{.cursorrules,.windsurfrules,copilot-instructions.md}",
  "**/package*.json",
  "**/{npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml,pnpm-workspace.yaml,bun.lock,bun.lockb,bunfig.toml}",
  "**/{pyproject.toml,poetry.lock,uv.lock,requirements*.txt,Pipfile*,setup.py,setup.cfg,Cargo.toml,Cargo.lock,go.mod,go.sum,Gemfile*,composer.json,composer.lock}",
  "**/{tsconfig,jsconfig}*.json",
  "**/biome.json*",
  "**/*.config.*",
  "**/{.*rc*,.releaserc*,deno.json*,.pnpmfile.cjs,pnpmfile.cjs,.pnp.*}",
  "**/{.eslintrc*,.prettierrc*,.babelrc*,.npmrc,.yarnrc*,.nvmrc,.node-version,.tool-versions,.editorconfig}",
  "**/{.gitignore,.gitattributes,.gitmodules,.dockerignore}",
  "**/{Dockerfile,Containerfile}*",
  "**/*.{dockerfile,containerfile}",
  "**/docker-bake.*",
  "**/{compose,docker-compose}*.y*ml",
  "**/{Makefile,Justfile,Procfile,Taskfile*}",
  "**/*.{tf,tfvars,tfstate}",
  "**/{netlify.toml,vercel.json,fly.toml,serverless.*,wrangler.*}",
  "**/{id_rsa*,id_ed25519*,credentials*,secrets*}",
]
const MATCH_OPTIONS = { dot: true, nocase: true, nonegate: true, noext: true } as const
const hardDenied = picomatch(PROTECTED_PATTERNS, MATCH_OPTIONS)
const sensitiveOrUnclear =
  /\b(?:security|auth(?:entication|orization|n|z)?|oauth\d*|rbac|acl|jwt|login|logout|permissions?|access[ -]control|passwords?|credentials?|secrets?|tokens?|private[ -]keys?|encrypt(?:ion|ed)?|cryptograph\w*|sessions?|cookies?|csrf|xss|injection|vulnerabilit\w*|sandbox|infrastructure|deployment|architecture|breaking[ -](?:change|api)|large[ -]refactor|product[ -]decision|human[ -]decision|ambiguous|unclear|uncertain|unknown|unspecified|insufficient)\b/i

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`
  }
  const result = JSON.stringify(value)
  if (result === undefined) throw new Error("Invalid hash input")
  return result
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function identity(config: Config) {
  return {
    ...config.repository,
    owner: config.repository.owner.toLowerCase(),
    name: config.repository.name.toLowerCase(),
  }
}

export function safePath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 512 &&
    path === path.normalize("NFC") &&
    !/[\\:\p{Cc}\p{Cf}]/u.test(path) &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && !/[. ]$/.test(part))
  )
}

export function allowedPath(path: string, config: Config): boolean {
  if (
    !safePath(path) ||
    path.split("/").some((part) => PROTECTED_DIRECTORIES.has(part.toLowerCase()))
  )
    return false
  try {
    return (
      !hardDenied(path) &&
      !picomatch.isMatch(path, config.forbiddenPaths, MATCH_OPTIONS) &&
      picomatch.isMatch(path, config.allowedPaths, MATCH_OPTIONS)
    )
  } catch {
    return false
  }
}

export function eligible(decision: TriageDecision, config: Config): boolean {
  const result = triageSchema.safeParse(decision)
  if (!result.success) return false
  const value = result.data
  // No risk classifier can prove semantic safety. Defer all reported risks and
  // explicit uncertainty; these checks only restrict model output.
  return (
    value.eligible &&
    value.category !== "defer" &&
    !value.requiresHumanDecision &&
    value.risks.length === 0 &&
    !sensitiveOrUnclear.test(
      [value.reason, value.proposedFix, ...value.verificationPlan, ...value.affectedFiles].join(
        "\n",
      ),
    ) &&
    value.affectedFiles.length <= Math.min(config.maxChangedFiles, 10) &&
    new Set(value.affectedFiles.map((path) => path.toLowerCase())).size ===
      value.affectedFiles.length &&
    value.affectedFiles.every((path) => allowedPath(path, config))
  )
}

export function fingerprint(issue: Issue, botId: number): string {
  return hash({
    title: issue.title,
    body: issue.body,
    comments: issue.comments
      .filter((comment) => comment.authorId !== botId)
      .map(({ id, authorId, body }) => ({ id, authorId, body }))
      .sort(
        (a, b) =>
          a.id - b.id ||
          a.authorId - b.authorId ||
          (a.body < b.body ? -1 : a.body > b.body ? 1 : 0),
      ),
  })
}

export function policyHash(config: Config): string {
  return hash({
    revision: POLICY_REVISION,
    repository: identity(config),
    allowedPaths: [...new Set(config.allowedPaths.map((path) => path.toLowerCase()))].sort(),
    forbiddenPaths: [...new Set(config.forbiddenPaths.map((path) => path.toLowerCase()))].sort(),
    hardDirectories: [...PROTECTED_DIRECTORIES].sort(),
    hardPatterns: PROTECTED_PATTERNS,
    commands: config.commands,
    image: config.image,
    model: config.model,
    modelUrl: config.modelUrl,
    modelApi: config.modelApi,
    modelRevision: config.modelRevision,
    maxConcurrentJobs: config.maxConcurrentJobs,
    agentTimeoutMs: config.agentTimeoutMs,
    maxChangedFiles: config.maxChangedFiles,
    maxPatchBytes: config.maxPatchBytes,
  })
}

export function makeProposal(
  issue: Issue,
  snapshot: Snapshot,
  decision: TriageDecision,
  config: Config,
  botId: number,
  now = Date.now(),
): Proposal {
  if (
    issue.ref.id !== config.repository.id ||
    issue.ref.installationId !== config.repository.installationId ||
    issue.ref.owner.toLowerCase() !== config.repository.owner.toLowerCase() ||
    issue.ref.name.toLowerCase() !== config.repository.name.toLowerCase() ||
    !Number.isSafeInteger(issue.ref.issueId) ||
    issue.ref.issueId <= 0 ||
    !Number.isSafeInteger(issue.ref.number) ||
    issue.ref.number <= 0 ||
    issue.state !== "open" ||
    issue.pullRequest ||
    issue.labels.includes("bot:skip") ||
    !Number.isSafeInteger(botId) ||
    botId <= 0 ||
    !eligible(decision, config)
  ) {
    throw new Error("Issue is not eligible for a proposal")
  }
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > Number.MAX_SAFE_INTEGER - DAY_MS ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(snapshot.sha) ||
    snapshot.branch.length === 0 ||
    snapshot.branch.length > 255 ||
    /[\p{Cc}]/u.test(snapshot.branch)
  ) {
    throw new Error("Invalid proposal baseline")
  }
  // The reader must reject oversized evidence, not truncate it. This is a second
  // boundary for callers that do not use the GitHub reader.
  if (
    issue.comments.length > 100 ||
    Buffer.byteLength(
      [issue.title, issue.body, ...issue.comments.map((comment) => comment.body)].join(""),
    ) > 131_072
  ) {
    throw new Error("Issue context exceeds the evidence limit")
  }
  const normalized = triageSchema.parse(decision)
  normalized.affectedFiles.sort()
  const proposal = {
    ref: { ...issue.ref },
    fingerprint: fingerprint(issue, botId),
    baseBranch: snapshot.branch,
    baseSha: snapshot.sha.toLowerCase(),
    decision: normalized,
    commands: config.commands.map((argv) => [...argv]),
    policyHash: policyHash(config),
    image: config.image,
    createdAt: Math.floor(now / 1_000) * 1_000,
    expiresAt: Math.floor(now / 1_000) * 1_000 + DAY_MS,
  }
  const dependencies = Object.entries(snapshot.files)
    .filter(([path]) =>
      /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i.test(
        path,
      ),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, file]) => ({
      path,
      mode: file.mode,
      hash: createHash("sha256").update(file.content).digest("hex"),
    }))
  return { revision: hash({ ...proposal, dependencies }), ...proposal }
}
