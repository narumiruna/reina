export interface Repository {
  owner: string
  name: string
  id: number
  installationId: number
}

export interface IssueRef extends Repository {
  number: number
  issueId: number
}

export interface Issue {
  ref: IssueRef
  title: string
  body: string
  comments: { id: number; authorId: number; body: string }[]
  labels: string[]
  state: "open" | "closed"
  pullRequest: boolean
}

export interface SourceFile {
  content: Buffer
  mode: "100644" | "100755"
}

export interface Snapshot {
  branch: string
  sha: string
  files: Record<string, SourceFile>
}

export interface TriageDecision {
  eligible: boolean
  category: "documentation" | "typo" | "bug" | "tests" | "behavior" | "error-handling" | "defer"
  reason: string
  proposedFix: string
  affectedFiles: string[]
  verificationPlan: string[]
  requiresHumanDecision: boolean
  risks: string[]
}

export interface Proposal {
  revision: string
  ref: IssueRef
  fingerprint: string
  baseBranch: string
  baseSha: string
  decision: TriageDecision
  commands: string[][]
  policyHash: string
  image: string
  createdAt: number
  expiresAt: number
  commentIntent?: boolean
  commentId?: number
  publishedAt?: number
}

export interface Actor {
  id: number
  login: string
  type: string
}

export interface LabelEvent {
  id: string
  event: "labeled" | "unlabeled" | "closed" | "reopened"
  // Issue lifecycle events have no label.
  label: string
  actor: Actor
  createdAt: number
}

export interface Approval {
  eventId: string
  actor: Actor
  proposalRevision: string
  createdAt: number
  permission: string
}

export type JobState =
  | "approved"
  | "working"
  | "validating"
  | "publishing"
  | "pr_ready"
  | "failed"
  | "cancelled"

export interface ChangedFile {
  path: string
  content: string | null
  mode: "100644" | "100755"
}

export interface Verification {
  argv: string[]
  exitCode: number
  durationMs: number
  image: string
}

export interface Artifact {
  files: ChangedFile[]
  diff: string
  hash: string
  verification: Verification[]
}

export interface Publication {
  branch: string
  commitSha?: string
  prIntent?: boolean
  prNumber?: number
  prUrl?: string
}

export interface Job {
  id: string
  ref: IssueRef
  proposalRevision: string
  approval: Approval
  state: JobState
  createdAt: number
  updatedAt: number
  notified?: boolean
  artifact?: Artifact
  publication?: Publication
  error?: string
}

export interface Logger {
  info(fields: Record<string, unknown>, message?: string): void
  error(fields: Record<string, unknown>, message?: string): void
}

export interface Config {
  repository: Repository
  stateDir: string
  image: string
  model: string
  modelUrl: string
  modelKey: string
  allowedPaths: string[]
  forbiddenPaths: string[]
  commands: string[][]
  scanIntervalMs: number
  maxIssuesPerScan: number
  maxConcurrentJobs: 1
  agentTimeoutMs: number
  maxChangedFiles: number
  maxPatchBytes: number
}

export interface ExecutionResult {
  finalText: string
  files: Record<string, SourceFile>
}

export interface AgentRuntime {
  preflight(): Promise<void>
  triage(snapshot: Snapshot, prompt: string, signal: AbortSignal): Promise<string>
  code(snapshot: Snapshot, prompt: string, signal: AbortSignal): Promise<ExecutionResult>
  verify(snapshot: Snapshot, commands: string[][], signal: AbortSignal): Promise<Verification[]>
  cleanup(): Promise<void>
}
