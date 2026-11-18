import { createHash, randomUUID } from "node:crypto"
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { TriageAdmission, TriageAdmissionRecord } from "../triage/admission.js"
import { safePath } from "../triage/policy.js"
import {
  type Review,
  type ReviewInvalidation,
  reviewSchema,
  staleReview,
} from "../triage/review.js"
import { triageSchema } from "../triage/schema.js"
import type { Approval, ExecutionRequest, IssueRef, Job, JobState, Proposal } from "../types.js"

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const TRIAGE_REQUEST_TTL_MS = 86_400_000
const reviewCursorSchema = z
  .string()
  .max(33)
  .regex(/^(?:[1-9][0-9]{0,15}:[1-9][0-9]{0,15})?$/)
  .refine(
    (value) =>
      value === "" || value.split(":").every((id) => positiveId.safeParse(Number(id)).success),
  )
const gitSha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i)
const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"))
const refSchema = z.strictObject({
  owner: boundedText(39),
  name: boundedText(100),
  id: positiveId,
  installationId: positiveId,
  number: positiveId,
  issueId: positiveId,
})
const actorSchema = z.strictObject({
  id: positiveId,
  login: boundedText(100),
  type: boundedText(40),
})
const argvSchema = z.array(boundedText(4_096)).min(1).max(32)
const requestCandidateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("comment"),
    commentId: positiveId,
    bodyHash: digest,
    createdAt: timestamp,
    updatedAt: timestamp,
  }),
  z.object({
    kind: z.literal("assignment"),
    assigneeId: positiveId,
    createdAt: timestamp,
  }),
])
const requestBindingSchema = z.strictObject({
  fingerprint: digest,
  baseSha: gitSha,
  baseBranch: boundedText(255),
  policyHash: digest,
})
export type RequestBinding = z.infer<typeof requestBindingSchema>
export type { TriageAdmission, TriageAdmissionRecord } from "../triage/admission.js"

const triageSourceSchema = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9][A-Za-z0-9:._-]*$/)
const triageAdmissionSchema = z.strictObject({
  source: triageSourceSchema,
  ref: refSchema,
  binding: requestBindingSchema.extend({
    protocolRevision: boundedText(100).refine((value) => !/[\p{Cc}]/u.test(value)),
  }),
  createdAt: timestamp,
  candidateKey: digest.optional(),
})
const triageAdmissionRecordSchema: z.ZodType<TriageAdmissionRecord> = z.strictObject({
  ...triageAdmissionSchema.shape,
  status: z.enum(["pending", "claimed", "revoked"]),
  cleanupIntent: z.boolean(),
})

export interface DeliveryIntakeResult {
  queued: boolean
  revocations: {
    ref: IssueRef
    preservedJobIds: string[]
    preservedBindings: RequestBinding[]
    preservedTriageSources: string[]
  }[]
  reviews: {
    ref: IssueRef
    reason: ReviewInvalidation["reason"]
    revision: string
  }[]
}
const approvalSchema: z.ZodType<Approval> = z.strictObject({
  eventId: boundedText(200),
  actor: actorSchema,
  proposalRevision: digest,
  createdAt: timestamp,
  permission: boundedText(30),
  request: z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("comment"),
        commentId: positiveId,
        bodyHash: digest,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      z.strictObject({
        kind: z.literal("assignment"),
        eventId: boundedText(200),
        assigneeId: positiveId,
        createdAt: timestamp,
      }),
    ])
    .optional(),
})
const proposalSchema: z.ZodType<Proposal> = z
  .strictObject({
    revision: digest,
    ref: refSchema,
    fingerprint: digest,
    baseBranch: boundedText(255),
    baseSha: gitSha,
    decision: triageSchema,
    commands: z.array(argvSchema).min(1).max(8),
    policyHash: digest,
    image: boundedText(512),
    createdAt: timestamp,
    expiresAt: timestamp,
    commentIntent: z.boolean().optional(),
    commentRetryAt: timestamp.optional(),
    commentId: positiveId.optional(),
    publishedAt: timestamp.optional(),
  })
  .refine(
    (value) =>
      value.expiresAt === value.createdAt + 86_400_000 &&
      value.decision.eligible &&
      value.decision.category !== "defer" &&
      !value.decision.requiresHumanDecision &&
      value.decision.risks.length === 0 &&
      value.decision.affectedFiles.every(safePath) &&
      (value.commentRetryAt === undefined ||
        (value.commentIntent === true &&
          value.commentId === undefined &&
          value.publishedAt === undefined)) &&
      (value.publishedAt === undefined ||
        (value.commentId !== undefined &&
          value.publishedAt >= value.createdAt &&
          value.publishedAt < value.expiresAt)),
  )
const artifactSchema = z.strictObject({
  files: z
    .array(
      z.strictObject({
        path: boundedText(512).refine(safePath),
        content: z
          .string()
          .max(1_398_104)
          .refine((value) => {
            const bytes = Buffer.from(value, "base64")
            return bytes.byteLength <= 1_048_576 && bytes.toString("base64") === value
          })
          .nullable(),
        mode: z.enum(["100644", "100755"]),
      }),
    )
    .min(1)
    .max(10)
    .refine((files) => new Set(files.map((file) => file.path)).size === files.length),
  diff: boundedText(65_536).refine((value) => Buffer.byteLength(value) <= 65_536),
  hash: digest,
  verification: z
    .array(
      z.strictObject({
        argv: argvSchema,
        exitCode: z.number().int().min(0).max(255),
        durationMs: z.number().finite().min(0).max(180_000),
        image: boundedText(512),
      }),
    )
    .min(1)
    .max(8),
})
const publicationSchema = z
  .strictObject({
    branch: boundedText(255),
    commitSha: gitSha.optional(),
    prIntent: z.boolean().optional(),
    prRetryAt: timestamp.optional(),
    prNumber: positiveId.optional(),
    prUrl: z
      .string()
      .max(2_048)
      .refine((value) => {
        try {
          const url = new URL(value)
          return url.protocol === "https:" && !url.username && !url.password
        } catch {
          return false
        }
      })
      .optional(),
  })
  .refine(
    (value) =>
      value.prRetryAt === undefined ||
      (value.prIntent === true &&
        value.commitSha !== undefined &&
        value.prNumber === undefined &&
        value.prUrl === undefined),
  )
const jobSchema: z.ZodType<Job> = z
  .strictObject({
    id: boundedText(100),
    ref: refSchema,
    proposalRevision: digest,
    approval: approvalSchema,
    state: z.enum([
      "approved",
      "working",
      "validating",
      "publishing",
      "pr_ready",
      "failed",
      "cancelled",
    ]),
    createdAt: timestamp,
    updatedAt: timestamp,
    notified: z.boolean().optional(),
    artifact: artifactSchema.optional(),
    publication: publicationSchema.optional(),
    error: boundedText(1_000).optional(),
  })
  .refine(
    (job) =>
      job.updatedAt >= job.createdAt &&
      job.approval.proposalRevision === job.proposalRevision &&
      (job.notified !== true || ["pr_ready", "failed", "cancelled"].includes(job.state)) &&
      (!(job.state === "publishing" || job.state === "pr_ready") ||
        job.artifact?.verification.every((check) => check.exitCode === 0)) &&
      (job.state !== "pr_ready" ||
        (job.publication?.prIntent === true &&
          job.publication.commitSha !== undefined &&
          job.publication.prNumber !== undefined &&
          job.publication.prUrl !== undefined)),
  )

const ACTIVE_STATES: JobState[] = ["approved", "working", "validating", "publishing"]
const TRANSITIONS: Record<JobState, readonly JobState[]> = {
  approved: ["working", "failed", "cancelled"],
  working: ["validating", "failed", "cancelled"],
  validating: ["publishing", "failed", "cancelled"],
  publishing: ["pr_ready", "failed", "cancelled"],
  pr_ready: [],
  failed: [],
  cancelled: [],
}
const MAX_DELIVERY_BYTES = 2_097_152
const MAX_DELIVERY_ATTEMPTS = 8
const credentialField =
  /^(?:authorization|private[_-]?key|webhook[_-]?secret|model[_-]?key|(?:access|refresh|installation)[_-]?token|client[_-]?secret|password|token)$/i

type Row = Record<string, unknown>

function key(ref: IssueRef): string {
  const value = refSchema.safeParse(ref)
  if (!value.success) throw new Error("Invalid issue reference")
  // Repository and issue IDs survive an installation or repository-name change.
  return `${value.data.id}:${value.data.issueId}`
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, entry]) => `${JSON.stringify(name)}:${stable(entry)}`)
      .join(",")}}`
  }
  const result = JSON.stringify(value)
  if (result === undefined) throw new Error("Invalid record value")
  return result
}

function sameRef(a: IssueRef, b: IssueRef): boolean {
  return (
    a.id === b.id &&
    a.installationId === b.installationId &&
    a.issueId === b.issueId &&
    a.number === b.number &&
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  )
}

function sameReviewPins(a: IssueRef, b: IssueRef): boolean {
  return (
    a.id === b.id &&
    a.installationId === b.installationId &&
    a.issueId === b.issueId &&
    a.number === b.number &&
    a.owner.toLowerCase() === b.owner.toLowerCase()
  )
}

function requestSource(payload: unknown):
  | {
      ref: IssueRef
      request: z.infer<typeof requestCandidateSchema>
      createdAt: number
      requestKey: string
    }
  | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const candidate = payload as Record<string, unknown>
  const ref = refSchema.safeParse(candidate.ref)
  const request = requestCandidateSchema.safeParse(candidate.request)
  if (
    candidate.kind !== "issue" ||
    candidate.retriage !== undefined ||
    !ref.success ||
    !request.success
  )
    return undefined
  const identity = {
    repositoryId: ref.data.id,
    installationId: ref.data.installationId,
    issueId: ref.data.issueId,
    ...(request.data.kind === "comment"
      ? { kind: "comment", commentId: request.data.commentId }
      : {
          kind: "assignment",
          assigneeId: request.data.assigneeId,
          createdAt: request.data.createdAt,
        }),
  }
  return {
    ref: ref.data,
    request: request.data,
    createdAt: request.data.createdAt,
    requestKey: createHash("sha256").update(stable(identity)).digest("hex"),
  }
}

function retriageSource(
  payload: unknown,
): { ref: IssueRef; candidateKey: string; createdAt: number; requestKey: string } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const candidate = payload as Record<string, unknown>
  const ref = refSchema.safeParse(candidate.ref)
  const actor = actorSchema.safeParse(candidate.actor)
  const retriage = z
    .strictObject({ candidateKey: digest, createdAt: timestamp })
    .safeParse(candidate.retriage)
  if (candidate.kind !== "issue" || !ref.success || !actor.success || !retriage.success)
    return undefined
  // The signed candidate digest, not a mutable envelope or delivery GUID, is the receipt.
  return {
    ref: ref.data,
    candidateKey: retriage.data.candidateKey,
    createdAt: retriage.data.createdAt,
    requestKey: createHash("sha256").update(`retriage:${retriage.data.candidateKey}`).digest("hex"),
  }
}

function requestBinding(value: Proposal | Pick<Review, "binding">): RequestBinding {
  const pins = "binding" in value ? value.binding : value
  return {
    fingerprint: pins.fingerprint,
    baseSha: pins.baseSha,
    baseBranch: pins.baseBranch,
    policyHash: pins.policyHash,
  }
}

function changeCutoff(payload: unknown, ref: IssueRef): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const candidate = payload as Record<string, unknown>
  const candidateRef = refSchema.safeParse(candidate.ref)
  const changedAt = timestamp.safeParse(candidate.changedAt)
  return candidate.kind === "issue" &&
    (candidate.material === true || candidate.cancel === true) &&
    candidateRef.success &&
    sameRef(candidateRef.data, ref) &&
    changedAt.success
    ? changedAt.data
    : undefined
}

function parseRecord<T>(schema: z.ZodType<T>, value: unknown, kind: string): T {
  try {
    if (typeof value !== "string" || Buffer.byteLength(value) > 16_777_216) throw new Error()
    return schema.parse(JSON.parse(value))
  } catch {
    throw new Error(`Invalid persisted ${kind} record`)
  }
}

function validate<T>(schema: z.ZodType<T>, value: unknown, kind: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error(`Invalid ${kind} record`)
  return result.data
}

function deliveryId(id: string): void {
  if (typeof id !== "string" || !id.trim() || id.length > 200 || /[\p{Cc}]/u.test(id))
    throw new Error("Invalid delivery ID")
}

function encodePayload(payload: unknown): string {
  let nodes = 0
  const ancestors = new Set<object>()
  function visit(value: unknown, depth: number): void {
    if (++nodes > 100_000 || depth > 32) throw new Error("Delivery payload exceeds limits")
    if (value === null || typeof value === "boolean" || typeof value === "string") return
    if (typeof value === "number" && Number.isFinite(value)) return
    if (typeof value !== "object" || value === null || ancestors.has(value))
      throw new Error("Delivery payload is not JSON")
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Delivery payload is not JSON")
    ancestors.add(value)
    for (const [name, entry] of Object.entries(value)) {
      if (credentialField.test(name))
        throw new Error("Delivery payload contains a credential field")
      visit(entry, depth + 1)
    }
    ancestors.delete(value)
  }
  visit(payload, 0)
  const json = JSON.stringify(payload)
  if (json === undefined || Buffer.byteLength(json) > MAX_DELIVERY_BYTES)
    throw new Error("Delivery payload exceeds limits")
  return json
}

export function privateFile(path: string): void {
  try {
    closeSync(
      openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      ),
    )
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
  }
  const stat = lstatSync(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Unsafe state file")
  chmodSync(path, 0o600)
}

export class Store {
  private db?: DatabaseSync
  private lock?: DatabaseSync
  private closed = false

  constructor(stateDir: string) {
    if (!isAbsolute(stateDir) || stateDir !== resolve(stateDir))
      throw new Error("State directory must be absolute")
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(stateDir)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe state directory")
    chmodSync(stateDir, 0o700)
    try {
      const lockPath = join(stateDir, "instance.sqlite")
      privateFile(lockPath)
      this.lock = new DatabaseSync(lockPath, { timeout: 0 })
      try {
        // A separate rollback-journal database keeps the process lock independent
        // of WAL transactions. The OS releases this handle after a crash.
        this.lock.exec(
          "PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS instance (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;",
        )
      } catch {
        throw new Error("State directory is locked by another Reina process")
      }
      const databasePath = join(stateDir, "reina.sqlite")
      privateFile(databasePath)
      this.db = new DatabaseSync(databasePath, { timeout: 0, enableForeignKeyConstraints: true })
      const mode = this.db.prepare("PRAGMA journal_mode = WAL").get()
      if (mode?.journal_mode !== "wal") throw new Error("WAL mode is unavailable")
      this.db.exec(
        "PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;",
      )
      this.migrate()
      this.recover()
    } catch (error) {
      this.close()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.db?.close()
    } finally {
      this.db = undefined
      this.lock?.close()
      this.lock = undefined
    }
  }

  private database(): DatabaseSync {
    if (this.closed || !this.db) throw new Error("Store is closed")
    return this.db
  }

  private transaction<T>(operation: () => T): T {
    const db = this.database()
    db.exec("BEGIN IMMEDIATE")
    try {
      const value = operation()
      db.exec("COMMIT")
      return value
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
  }

  private migrate(): void {
    const db = this.database()
    const version = db.prepare("PRAGMA user_version").get()?.user_version
    if (version === 7) return
    if (![0, 1, 2, 3, 4, 5, 6].includes(Number(version)))
      throw new Error("Unsupported state database version")
    this.transaction(() => {
      if (version === 1 || version === 2 || version === 3) {
        if (version === 1)
          db.exec(
            "CREATE TABLE assessments (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;",
          )
        if (version < 3)
          db.exec(`CREATE UNIQUE INDEX one_active_job_slot ON jobs((1)) WHERE state IN ('approved','working','validating','publishing');
            CREATE TABLE scan_cursor (id INTEGER PRIMARY KEY CHECK(id = 1), page INTEGER NOT NULL CHECK(page BETWEEN 1 AND 9007199254740991)) STRICT;
            INSERT INTO scan_cursor(id,page) VALUES(1,1);`)
        db.exec(`ALTER TABLE deliveries ADD COLUMN global_until INTEGER NOT NULL DEFAULT 0 CHECK(global_until >= 0);
          UPDATE deliveries SET global_until = available_at WHERE attempts > 0;
          PRAGMA user_version = 4;`)
      }
      if (version === 0)
        db.exec(`
        CREATE TABLE deliveries (
          id TEXT PRIMARY KEY, payload TEXT, status TEXT NOT NULL CHECK(status IN ('pending','complete','failed')),
          accepted_at INTEGER NOT NULL, available_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
          global_until INTEGER NOT NULL DEFAULT 0 CHECK(global_until >= 0)
        ) STRICT;
        CREATE TABLE proposals (
          revision TEXT PRIMARY KEY, issue_key TEXT NOT NULL, json TEXT NOT NULL,
          valid INTEGER NOT NULL CHECK(valid IN (0,1))
        ) STRICT;
        CREATE TABLE proposal_heads (
          issue_key TEXT PRIMARY KEY, revision TEXT NOT NULL REFERENCES proposals(revision)
        ) STRICT;
        CREATE TABLE approvals (
          event_id TEXT PRIMARY KEY, issue_key TEXT NOT NULL,
          proposal_revision TEXT NOT NULL REFERENCES proposals(revision), json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, issue_key TEXT NOT NULL,
          proposal_revision TEXT NOT NULL REFERENCES proposals(revision),
          approval_event_id TEXT NOT NULL UNIQUE REFERENCES approvals(event_id),
          state TEXT NOT NULL CHECK(state IN ('approved','working','validating','publishing','pr_ready','failed','cancelled')),
          json TEXT NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX one_active_job_per_issue ON jobs(issue_key)
          WHERE state IN ('approved','working','validating','publishing');
        CREATE UNIQUE INDEX one_active_job_slot ON jobs((1))
          WHERE state IN ('approved','working','validating','publishing');
        CREATE INDEX jobs_by_issue ON jobs(issue_key);
        CREATE INDEX deliveries_ready ON deliveries(status, available_at);
        CREATE TABLE assessments (key TEXT PRIMARY KEY, created_at INTEGER NOT NULL) STRICT;
        CREATE TABLE scan_cursor (id INTEGER PRIMARY KEY CHECK(id = 1), page INTEGER NOT NULL CHECK(page BETWEEN 1 AND 9007199254740991)) STRICT;
        INSERT INTO scan_cursor(id,page) VALUES(1,1);
      `)
      if (Number(version) < 5)
        db.exec(`
        CREATE TABLE reviews (
          issue_key TEXT PRIMARY KEY,
          revision TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','running','assessed','complete','stale','failed')),
          json TEXT NOT NULL CHECK(length(CAST(json AS BLOB)) <= 65536)
        ) STRICT;
        CREATE TABLE review_cursor (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          issue_key TEXT NOT NULL
        ) STRICT;
        INSERT INTO review_cursor(id,issue_key) VALUES(1,'');
        PRAGMA user_version = 5;
      `)
      if (Number(version) < 6) {
        db.exec(`
        ALTER TABLE deliveries ADD COLUMN request_key TEXT
          CHECK(request_key IS NULL OR (length(request_key) = 64 AND request_key NOT GLOB '*[^a-f0-9]*'));
        CREATE INDEX deliveries_by_request ON deliveries(request_key) WHERE request_key IS NOT NULL;
        CREATE TABLE request_epoch (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          reject_before INTEGER CHECK(reject_before IS NULL OR reject_before >= 0)
        ) STRICT;
      `)
        // Completed legacy receipts have lost their source. Preserve a replay cutoff.
        db.prepare("INSERT INTO request_epoch(id,reject_before) VALUES(1,?)").run(
          version === 0 ? null : Date.now(),
        )
        for (const row of db.prepare("SELECT id,payload,status FROM deliveries").all()) {
          if (typeof row.payload !== "string") continue
          const payload = JSON.parse(row.payload)
          encodePayload(payload)
          const source = requestSource(payload)
          if (!source) continue
          db.prepare("UPDATE deliveries SET request_key = ? WHERE id = ?").run(
            source.requestKey,
            row.id as string,
          )
          if (
            row.status === "pending" &&
            (!requestBindingSchema.safeParse(payload.requestBinding).success ||
              !actorSchema.safeParse(payload.actor).success ||
              payload.actor.type !== "User" ||
              !digest.safeParse(payload.requestIssueHash).success)
          )
            db.prepare(
              "UPDATE deliveries SET status = 'complete', payload = NULL WHERE id = ?",
            ).run(row.id as string)
        }
      }
      db.exec(`
        CREATE TABLE triage_initial (
          issue_key TEXT PRIMARY KEY
        ) STRICT;
        CREATE TABLE triage_admissions (
          source TEXT PRIMARY KEY,
          issue_key TEXT NOT NULL,
          candidate_key TEXT UNIQUE CHECK(candidate_key IS NULL OR
            (length(candidate_key) = 64 AND candidate_key NOT GLOB '*[^a-f0-9]*')),
          status TEXT NOT NULL CHECK(status IN ('pending','claimed','revoked')),
          json TEXT NOT NULL CHECK(length(CAST(json AS BLOB)) <= 4096)
        ) STRICT;
        CREATE INDEX triage_admissions_by_issue ON triage_admissions(issue_key,status);
        CREATE TABLE triage_coding_cutoffs (
          issue_key TEXT PRIMARY KEY,
          reject_before INTEGER NOT NULL CHECK(reject_before >= 0)
        ) STRICT;
        CREATE TABLE triage_epoch (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          label_after INTEGER NOT NULL CHECK(label_after >= 0),
          automatic_after INTEGER CHECK(automatic_after IS NULL OR automatic_after >= 0)
        ) STRICT;
      `)
      const now = Date.now()
      db.prepare("INSERT INTO triage_epoch(id,label_after,automatic_after) VALUES(1,?,?)").run(
        now,
        version === 0 ? null : now,
      )
      for (const row of db.prepare("SELECT id,payload FROM deliveries").all()) {
        if (typeof row.payload !== "string") continue
        const payload = JSON.parse(row.payload)
        encodePayload(payload)
        const source = retriageSource(payload)
        if (source)
          db.prepare(
            "UPDATE deliveries SET request_key = ?, status = 'complete', payload = NULL WHERE id = ?",
          ).run(source.requestKey, row.id as string)
      }
      if (version !== 0) {
        // Every known legacy cycle is ambiguous, including zero-attempt pending work.
        for (const row of db.prepare("SELECT * FROM reviews").all())
          this.reserveAutomaticTriage(this.readReview(row).ref)
        for (const row of db.prepare("SELECT revision,issue_key,json FROM proposals").all()) {
          const proposal = parseRecord(proposalSchema, row.json, "proposal")
          if (row.issue_key !== key(proposal.ref) || row.revision !== proposal.revision)
            throw new Error("Inconsistent proposal identity")
          this.reserveAutomaticTriage(proposal.ref)
        }
        for (const row of db.prepare("SELECT * FROM jobs").all())
          this.reserveAutomaticTriage(this.readJob(row).ref)
        this.retireInference()
      }
      db.exec("PRAGMA user_version = 7;")
    })
  }

  private recover(): void {
    this.transaction(() => {
      for (const job of this.jobs()) {
        if (job.state === "approved" || job.state === "working" || job.state === "validating") {
          this.updateJob({
            ...job,
            state: "failed",
            updatedAt: Math.max(Date.now(), job.updatedAt),
            error: "interrupted",
          })
        }
      }
      this.retireInference()
    })
  }

  private retireInference(): void {
    const db = this.database()
    for (const row of db
      .prepare("SELECT * FROM reviews WHERE state IN ('running','pending')")
      .all()) {
      const review = this.readReview(row)
      if (review.state === "pending" && review.attempts === 0) continue
      this.reserveAutomaticTriage(review.ref)
      const recovered = validate(
        reviewSchema,
        {
          ...review,
          state: "failed",
          updatedAt: Math.max(Date.now(), review.updatedAt),
          nextAttemptAt: 0,
          error:
            review.state === "running" ? "triage_interrupted" : (review.error ?? "triage_failed"),
        },
        "review",
      )
      db.prepare("UPDATE reviews SET state = ?, json = ? WHERE issue_key = ?").run(
        recovered.state,
        JSON.stringify(recovered),
        key(recovered.ref),
      )
    }
  }

  scanPage(): number {
    const row = this.database().prepare("SELECT page FROM scan_cursor WHERE id = 1").get()
    return validate(positiveId, row?.page, "scan cursor")
  }

  saveScanPage(page: number): void {
    const db = this.database()
    const value = validate(positiveId, page, "scan cursor")
    if (db.prepare("UPDATE scan_cursor SET page = ? WHERE id = 1").run(value).changes !== 1)
      throw new Error("Missing scan cursor record")
  }

  private triageEpoch(): { labelAfter: number; automaticAfter: number | null } {
    const row = this.database()
      .prepare("SELECT label_after,automatic_after FROM triage_epoch WHERE id = 1")
      .get()
    if (!row) throw new Error("Missing triage epoch record")
    return {
      labelAfter: validate(timestamp, row.label_after, "triage epoch"),
      automaticAfter:
        row.automatic_after === null
          ? null
          : validate(timestamp, row.automatic_after, "automatic triage epoch"),
    }
  }

  private reserveAutomaticTriage(ref: IssueRef): void {
    this.database()
      .prepare("INSERT INTO triage_initial(issue_key) VALUES(?) ON CONFLICT(issue_key) DO NOTHING")
      .run(key(ref))
  }

  automaticTriageAllowed(ref: IssueRef, issueCreatedAt?: number): boolean {
    const issueKey = key(ref)
    if (issueCreatedAt !== undefined && !timestamp.safeParse(issueCreatedAt).success) return false
    if (issueCreatedAt !== undefined && issueCreatedAt > Date.now()) return false
    const cutoff = this.triageEpoch().automaticAfter
    return (
      !this.database()
        .prepare("SELECT issue_key FROM triage_initial WHERE issue_key = ?")
        .get(issueKey) &&
      (cutoff === null || (issueCreatedAt !== undefined && issueCreatedAt > cutoff))
    )
  }

  private readTriageAdmission(row: Row): TriageAdmissionRecord {
    if (typeof row.json !== "string" || Buffer.byteLength(row.json) > 4_096)
      throw new Error("Invalid persisted triage admission record")
    const admission = parseRecord(triageAdmissionRecordSchema, row.json, "triage admission")
    if (
      row.source !== admission.source ||
      row.issue_key !== key(admission.ref) ||
      row.status !== admission.status ||
      row.candidate_key !== (admission.candidateKey ?? null)
    )
      throw new Error("Inconsistent triage admission identity")
    return admission
  }

  triageAdmission(source: string): TriageAdmissionRecord | undefined {
    const db = this.database()
    const value = validate(triageSourceSchema, source, "triage source")
    const row = db.prepare("SELECT * FROM triage_admissions WHERE source = ?").get(value)
    return row ? this.readTriageAdmission(row) : undefined
  }

  triageAdmissionForCandidate(candidateKey: string): TriageAdmissionRecord | undefined {
    const db = this.database()
    const value = validate(digest, candidateKey, "triage candidate key")
    const row = db.prepare("SELECT * FROM triage_admissions WHERE candidate_key = ?").get(value)
    return row ? this.readTriageAdmission(row) : undefined
  }

  /** The caller must verify the live request before identifying its accepted delivery. */
  admitTriage(
    admission: TriageAdmission,
    receipt?: { deliveryId: string; request: ExecutionRequest },
  ): boolean {
    const parsed = triageAdmissionSchema.safeParse(admission)
    if (!parsed.success || parsed.data.candidateKey) return false
    const value = parsed.data
    return this.transaction(() => {
      if (this.retiredCodingRequest(value.ref, value.createdAt) || value.createdAt > Date.now())
        return false
      const pending =
        receipt && this.pendingDirectReceipt(value, receipt.deliveryId, receipt.request)
      if (receipt && !pending) return false
      const previous = this.triageAdmission(value.source)
      if (previous) return this.samePendingAdmission(previous, value)
      const cutoff = this.requestEpoch()
      if (
        cutoff !== null &&
        value.createdAt <= cutoff &&
        (!pending || !this.unspentMigratedReceipt(pending, cutoff))
      )
        return false
      this.insertTriageAdmission(value)
      return true
    })
  }

  /** Admit a verified read-only transition and retire older coding authority together. */
  beginRetriage(admission: TriageAdmission, id: string): boolean {
    const parsed = triageAdmissionSchema.safeParse(admission)
    if (!parsed.success || !parsed.data.candidateKey) return false
    const value = parsed.data
    return this.transaction(() => {
      const row = this.pendingDelivery(id)
      const candidate = row && retriageSource(row.payload)
      const actor = actorSchema.safeParse(row?.payload.actor)
      const prefix = `retriage:${value.ref.installationId}:${value.ref.id}:${value.ref.issueId}:${value.ref.number}:`
      if (
        !candidate ||
        candidate.requestKey !== row?.requestKey ||
        !sameRef(candidate.ref, value.ref) ||
        candidate.candidateKey !== value.candidateKey ||
        candidate.createdAt !== value.createdAt ||
        !actor.success ||
        actor.data.type !== "User" ||
        !value.source.startsWith(prefix) ||
        !/^[1-9]\d*$/.test(value.source.slice(prefix.length)) ||
        value.createdAt > Date.now() ||
        value.createdAt <= this.triageEpoch().labelAfter
      )
        return false
      const previous = this.triageAdmission(value.source)
      if (previous) return this.samePendingAdmission(previous, value)
      if (this.triageAdmissionForCandidate(candidate.candidateKey)) return false

      this.retireCodingReceipts(value.ref, value.createdAt)
      this.invalidateRecords(value.ref)
      const review = this.review(value.ref)
      if (review) this.storeStaleReview(review, "changed", Date.now())
      const newer = this.newerRequests(value.ref, value.createdAt)
      this.revokeTriageAdmissions(
        value.ref,
        (other) =>
          other.createdAt > value.createdAt &&
          sameRef(other.ref, value.ref) &&
          stable(other.binding) === stable(value.binding) &&
          (other.candidateKey !== undefined ||
            (!this.retiredCodingRequest(other.ref, other.createdAt) &&
              newer.some(
                ({ source, binding }) =>
                  binding !== undefined &&
                  stable(binding) === stable(requestBinding(other)) &&
                  source.createdAt === other.createdAt &&
                  this.matchesDirectSource(other, source.request),
              ))),
      )
      this.insertTriageAdmission(value)
      return true
    })
  }

  private samePendingAdmission(previous: TriageAdmissionRecord, value: TriageAdmission): boolean {
    const { status, cleanupIntent: _cleanup, ...identity } = previous
    return status === "pending" && stable(identity) === stable(value)
  }

  private insertTriageAdmission(value: TriageAdmission): void {
    const record: TriageAdmissionRecord = { ...value, status: "pending", cleanupIntent: false }
    this.database()
      .prepare(
        "INSERT INTO triage_admissions(source,issue_key,candidate_key,status,json) VALUES(?,?,?,?,?)",
      )
      .run(
        value.source,
        key(value.ref),
        value.candidateKey ?? null,
        record.status,
        JSON.stringify(record),
      )
    // Human-first work reserves the initial budget even if it is later cancelled.
    this.reserveAutomaticTriage(value.ref)
  }

  private updateTriageAdmission(admission: TriageAdmissionRecord): void {
    this.database()
      .prepare("UPDATE triage_admissions SET status = ?, json = ? WHERE source = ?")
      .run(admission.status, JSON.stringify(admission), admission.source)
  }

  /** Commit one-use DELETE authority before any remote label write. */
  startTriageCleanup(source: string): boolean {
    return this.transaction(() => {
      const admission = this.triageAdmission(source)
      if (admission?.status !== "pending" || !admission.candidateKey || admission.cleanupIntent)
        return false
      if (
        admission.createdAt > Date.now() ||
        admission.createdAt + TRIAGE_REQUEST_TTL_MS <= Date.now()
      ) {
        this.updateTriageAdmission({ ...admission, status: "revoked" })
        return false
      }
      this.updateTriageAdmission({ ...admission, cleanupIntent: true })
      return true
    })
  }

  revokeTriage(source: string): void {
    this.transaction(() => {
      const admission = this.triageAdmission(source)
      if (admission?.status === "pending")
        this.updateTriageAdmission({ ...admission, status: "revoked" })
    })
  }

  private revokeTriageAdmissions(
    ref: IssueRef,
    preserve?: (admission: TriageAdmissionRecord) => boolean,
  ): void {
    for (const row of this.database()
      .prepare("SELECT * FROM triage_admissions WHERE issue_key = ? AND status = 'pending'")
      .all(key(ref))) {
      const admission = this.readTriageAdmission(row)
      if (!preserve?.(admission)) this.updateTriageAdmission({ ...admission, status: "revoked" })
    }
  }

  private preserveTriageBindings(
    scope: DeliveryIntakeResult["revocations"][number],
    cutoff?: number,
  ): void {
    if (cutoff === undefined) return
    const review = this.reviewForReconciliation(scope.ref)
    if (!review) return
    for (const row of this.database()
      .prepare("SELECT * FROM triage_admissions WHERE issue_key = ? AND status = 'pending'")
      .all(key(scope.ref))) {
      const admission = this.readTriageAdmission(row)
      if (
        admission.createdAt > cutoff &&
        sameRef(admission.ref, scope.ref) &&
        sameRef(review.ref, scope.ref) &&
        stable(admission.binding) === stable(review.binding)
      ) {
        if (admission.candidateKey) scope.preservedTriageSources.push(admission.source)
        else if (
          !scope.preservedBindings.some(
            (binding) => stable(binding) === stable(requestBinding(admission)),
          )
        )
          scope.preservedBindings.push(requestBinding(admission))
      }
    }
  }

  private revokeInvalidatedTriage(
    ref: IssueRef,
    scope: DeliveryIntakeResult["revocations"][number],
    cutoff?: number,
  ): void {
    const review = this.reviewForReconciliation(ref)
    this.revokeTriageAdmissions(
      ref,
      (admission) =>
        cutoff !== undefined &&
        admission.createdAt > cutoff &&
        sameRef(admission.ref, ref) &&
        review !== undefined &&
        stable(admission.binding) === stable(review.binding) &&
        (admission.candidateKey
          ? scope.preservedTriageSources.includes(admission.source)
          : scope.preservedBindings.some(
              (binding) => stable(binding) === stable(requestBinding(admission)),
            )),
    )
  }

  claimTriage(review: Review, source?: string, issueCreatedAt?: number): Review | undefined {
    const db = this.database()
    const parsed = reviewSchema.safeParse(review)
    if (!parsed.success || (source !== undefined && !triageSourceSchema.safeParse(source).success))
      return undefined
    const value = parsed.data
    return this.transaction(() => {
      const row = db.prepare("SELECT * FROM reviews WHERE issue_key = ?").get(key(value.ref))
      if (!row) return undefined
      const current = this.readReview(row)
      if (current.state !== "pending" || stable(current) !== stable(value)) return undefined
      let admission: TriageAdmissionRecord | undefined
      if (source !== undefined) {
        admission = this.triageAdmission(source)
        if (
          admission?.status !== "pending" ||
          !sameRef(admission.ref, current.ref) ||
          stable(admission.binding) !== stable(current.binding)
        )
          return undefined
      } else if (
        current.attempts !== 0 ||
        !this.automaticTriageAllowed(current.ref, issueCreatedAt)
      )
        return undefined
      if (
        admission &&
        !admission.candidateKey &&
        this.retiredCodingRequest(admission.ref, admission.createdAt)
      ) {
        this.updateTriageAdmission({ ...admission, status: "revoked" })
        return undefined
      }
      if (
        admission &&
        (admission.createdAt > Date.now() ||
          admission.createdAt + TRIAGE_REQUEST_TTL_MS <= Date.now())
      ) {
        this.updateTriageAdmission({ ...admission, status: "revoked" })
        return undefined
      }
      const running = reviewSchema.safeParse({
        ...current,
        state: "running",
        attempts: current.attempts + 1,
        updatedAt: Math.max(Date.now(), current.updatedAt),
        nextAttemptAt: 0,
      })
      if (!running.success) return undefined
      if (admission) this.updateTriageAdmission({ ...admission, status: "claimed" })
      this.reserveAutomaticTriage(current.ref)
      db.prepare("UPDATE reviews SET state = ?, json = ? WHERE issue_key = ?").run(
        running.data.state,
        JSON.stringify(running.data),
        key(current.ref),
      )
      return running.data
    })
  }

  private readReview(row: Row): Review {
    if (typeof row.json !== "string" || Buffer.byteLength(row.json) > 65_536)
      throw new Error("Invalid persisted review record")
    const review = parseRecord(reviewSchema, row.json, "review")
    if (
      row.issue_key !== key(review.ref) ||
      row.revision !== review.revision ||
      row.state !== review.state
    )
      throw new Error("Inconsistent review identity")
    return review
  }

  review(ref: IssueRef): Review | undefined {
    const row = this.database().prepare("SELECT * FROM reviews WHERE issue_key = ?").get(key(ref))
    if (!row) return undefined
    const review = this.readReview(row)
    if (!sameRef(review.ref, ref)) throw new Error("Inconsistent review identity")
    return review
  }

  /** Read the old name for reconciliation only; this does not grant authority. */
  reviewForReconciliation(ref: IssueRef): Review | undefined {
    const row = this.database().prepare("SELECT * FROM reviews WHERE issue_key = ?").get(key(ref))
    if (!row) return undefined
    const review = this.readReview(row)
    if (!sameReviewPins(review.ref, ref)) throw new Error("Inconsistent review identity")
    return review
  }

  /** Call only after live GitHub repository and issue checks confirm the pinned identity. */
  rebindReview(liveRef: IssueRef, expectedRevision: string): Review | undefined {
    const db = this.database()
    validate(z.uuid(), expectedRevision, "review revision")
    return this.transaction(() => {
      const current = this.reviewForReconciliation(liveRef)
      if (!current || current.revision !== expectedRevision) return undefined
      if (current.ref.name.toLowerCase() === liveRef.name.toLowerCase()) return current
      const { publishedRevision: _published, ...previous } = current
      const rebound = validate(
        reviewSchema,
        {
          ...staleReview({ ...previous, ref: { ...previous.ref, name: liveRef.name } }, "changed"),
          // Even an already-stale record must reject work from the old name.
          revision: randomUUID(),
          updatedAt: Math.max(Date.now(), current.updatedAt),
        },
        "review",
      )
      this.invalidateRecords(current.ref)
      this.revokeTriageAdmissions(current.ref)
      db.prepare("UPDATE reviews SET revision = ?, state = ?, json = ? WHERE issue_key = ?").run(
        rebound.revision,
        rebound.state,
        JSON.stringify(rebound),
        key(current.ref),
      )
      return rebound
    })
  }

  saveReview(review: Review, expectedRevision?: string): boolean {
    const db = this.database()
    const value = validate(reviewSchema, review, "review")
    if (expectedRevision !== undefined) validate(z.uuid(), expectedRevision, "review revision")
    return this.transaction(() => {
      const row = db.prepare("SELECT * FROM reviews WHERE issue_key = ?").get(key(value.ref))
      if (!row) {
        if (expectedRevision !== undefined) return false
        if (value.attempts > 0 || value.assessment !== undefined || value.state === "failed")
          this.reserveAutomaticTriage(value.ref)
        if (value.state === "stale") this.revokeTriageAdmissions(value.ref)
        db.prepare("INSERT INTO reviews(issue_key,revision,state,json) VALUES(?,?,?,?)").run(
          key(value.ref),
          value.revision,
          value.state,
          JSON.stringify(value),
        )
        return true
      }
      const previous = this.readReview(row)
      if (expectedRevision === undefined || previous.revision !== expectedRevision) return false
      if (
        value.updatedAt < previous.updatedAt ||
        !sameRef(value.ref, previous.ref) ||
        (value.revision === previous.revision &&
          (stable(value.binding) !== stable(previous.binding) ||
            value.createdAt !== previous.createdAt ||
            value.attempts < previous.attempts ||
            (previous.state === "failed" &&
              (value.state === "pending" || value.state === "running"))))
      )
        throw new Error("Invalid review cycle update")
      if (value.attempts > 0 || value.assessment !== undefined || value.state === "failed")
        this.reserveAutomaticTriage(value.ref)
      if (
        value.state === "stale" &&
        (previous.state !== "stale" || value.revision !== previous.revision)
      )
        this.revokeTriageAdmissions(value.ref)
      else if (value.revision !== previous.revision)
        this.revokeTriageAdmissions(
          value.ref,
          (admission) =>
            sameRef(admission.ref, value.ref) &&
            stable(admission.binding) === stable(value.binding),
        )
      db.prepare("UPDATE reviews SET revision = ?, state = ?, json = ? WHERE issue_key = ?").run(
        value.revision,
        value.state,
        JSON.stringify(value),
        key(value.ref),
      )
      return true
    })
  }

  reviewBatch(limit: number): Review[] {
    const db = this.database()
    const count = validate(z.number().int().min(1).max(100), limit, "review batch limit")
    return this.transaction(() => {
      const cursor = validate(
        reviewCursorSchema,
        db.prepare("SELECT issue_key FROM review_cursor WHERE id = 1").get()?.issue_key,
        "review cursor",
      )
      const rows = db
        .prepare("SELECT * FROM reviews WHERE issue_key > ? ORDER BY issue_key LIMIT ?")
        .all(cursor, count)
      if (rows.length < count)
        rows.push(
          ...db
            .prepare("SELECT * FROM reviews WHERE issue_key <= ? ORDER BY issue_key LIMIT ?")
            .all(cursor, count - rows.length),
        )
      const reviews = rows.map((row) => this.readReview(row))
      const last = reviews.at(-1)
      db.prepare("UPDATE review_cursor SET issue_key = ? WHERE id = 1").run(
        last ? key(last.ref) : "",
      )
      return reviews
    })
  }

  assessed(assessmentKey: string): boolean {
    const db = this.database()
    const value = validate(boundedText(1_024), assessmentKey, "assessment key")
    const digest = createHash("sha256").update(value).digest("hex")
    return db.prepare("SELECT key FROM assessments WHERE key = ?").get(digest) !== undefined
  }

  rememberAssessment(assessmentKey: string): void {
    const db = this.database()
    const value = validate(boundedText(1_024), assessmentKey, "assessment key")
    const digest = createHash("sha256").update(value).digest("hex")
    db.prepare(
      "INSERT INTO assessments(key,created_at) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
    ).run(digest, Date.now())
  }

  private retiredCodingRequest(ref: IssueRef, createdAt: number): boolean {
    const row = this.database()
      .prepare("SELECT reject_before FROM triage_coding_cutoffs WHERE issue_key = ?")
      .get(key(ref))
    return (
      row !== undefined &&
      createdAt <= validate(timestamp, row.reject_before, "coding request cutoff")
    )
  }

  private pendingDelivery(id: string) {
    deliveryId(id)
    const row = this.database()
      .prepare(
        "SELECT payload,request_key,accepted_at FROM deliveries WHERE id = ? AND status = 'pending'",
      )
      .get(id)
    if (typeof row?.payload !== "string") return undefined
    const payload = JSON.parse(row.payload)
    if (typeof payload !== "object" || payload === null) return undefined
    return {
      payload,
      requestKey: row.request_key,
      acceptedAt: validate(timestamp, row.accepted_at, "delivery acceptance"),
    }
  }

  private matchesDirectSource(
    admission: TriageAdmission,
    request: NonNullable<ReturnType<typeof requestSource>>["request"],
    eventId?: string,
  ): boolean {
    const { ref, source } = admission
    if (request.kind === "comment")
      return source === `fix-comment:${ref.id}:${ref.issueId}:${request.commentId}`
    const prefix = `fix-assignment:${ref.id}:${ref.issueId}:`
    return eventId === undefined
      ? source.startsWith(prefix) && /^[1-9]\d*$/.test(source.slice(prefix.length))
      : /^[1-9]\d*$/.test(eventId) && source === `${prefix}${eventId}`
  }

  private pendingDirectReceipt(admission: TriageAdmission, id: string, request: ExecutionRequest) {
    const row = this.pendingDelivery(id)
    if (!row) return undefined
    const source = requestSource(row.payload)
    const actor = actorSchema.safeParse(row.payload.actor)
    const candidate = requestCandidateSchema.safeParse(request)
    const binding = requestBindingSchema.safeParse(row.payload.requestBinding)
    if (
      !source ||
      source.requestKey !== row.requestKey ||
      !sameRef(source.ref, admission.ref) ||
      source.createdAt !== admission.createdAt ||
      !actor.success ||
      actor.data.type !== "User" ||
      !candidate.success ||
      stable(candidate.data) !== stable(source.request) ||
      !this.matchesDirectSource(
        admission,
        source.request,
        request.kind === "assignment" ? request.eventId : undefined,
      ) ||
      !binding.success ||
      stable(binding.data) !== stable(requestBinding(admission))
    )
      return undefined
    return { source, acceptedAt: row.acceptedAt, issueHash: row.payload.requestIssueHash }
  }

  private unspentMigratedReceipt(
    receipt: NonNullable<ReturnType<Store["pendingDirectReceipt"]>>,
    cutoff: number,
  ): boolean {
    const { source, acceptedAt, issueHash } = receipt
    if (acceptedAt > cutoff || !digest.safeParse(issueHash).success || this.consumedRequest(source))
      return false
    // A second payload-bearing legacy row or an assessment that may have run
    // since intake makes the request's unspent status ambiguous. Null payload
    // rows can be replay rejections written after migration, not attempts.
    const count = this.database()
      .prepare(
        "SELECT COUNT(*) AS count FROM deliveries WHERE request_key = ? AND payload IS NOT NULL",
      )
      .get(source.requestKey)?.count
    const review = this.review(source.ref)
    return (
      count === 1 &&
      (!review ||
        (review.attempts === 0 && !review.assessment && !review.error) ||
        review.updatedAt < acceptedAt)
    )
  }

  private consumedRequest(source: NonNullable<ReturnType<typeof requestSource>>): boolean {
    return this.database()
      .prepare("SELECT json FROM approvals WHERE issue_key = ?")
      .all(key(source.ref))
      .some((row) => {
        const approval = parseRecord(approvalSchema, row.json, "approval")
        return (
          approval.request !== undefined &&
          requestSource({ kind: "issue", ref: source.ref, request: approval.request })
            ?.requestKey === source.requestKey
        )
      })
  }

  private requestEpoch(): number | null {
    const row = this.database()
      .prepare("SELECT reject_before FROM request_epoch WHERE id = 1")
      .get()
    if (!row) throw new Error("Missing request epoch record")
    return row.reject_before === null
      ? null
      : validate(timestamp, row.reject_before, "request epoch")
  }

  private duplicateRequest(source: NonNullable<ReturnType<typeof requestSource>>): boolean {
    const cutoff = this.requestEpoch()
    return (
      this.retiredCodingRequest(source.ref, source.createdAt) ||
      this.database()
        .prepare("SELECT id FROM deliveries WHERE request_key = ? LIMIT 1")
        .get(source.requestKey) !== undefined ||
      this.consumedRequest(source) ||
      (cutoff !== null && source.createdAt <= cutoff)
    )
  }

  private newerRequests(ref: IssueRef, cutoff: number) {
    const requests: {
      source: NonNullable<ReturnType<typeof requestSource>>
      binding?: RequestBinding
    }[] = []
    for (const row of this.database()
      .prepare("SELECT payload FROM deliveries WHERE status = 'pending'")
      .all()) {
      if (typeof row.payload !== "string") continue
      const payload = JSON.parse(row.payload)
      const source = requestSource(payload)
      const actor = actorSchema.safeParse(payload?.actor)
      if (
        !source ||
        !sameRef(source.ref, ref) ||
        source.createdAt <= cutoff ||
        !actor.success ||
        actor.data.type !== "User"
      )
        continue
      const binding = requestBindingSchema.safeParse(payload.requestBinding)
      requests.push({ source, ...(binding.success ? { binding: binding.data } : {}) })
    }
    return requests
  }

  private revocationScope(
    ref: IssueRef,
    cutoff?: number,
  ): DeliveryIntakeResult["revocations"][number] {
    const scope: DeliveryIntakeResult["revocations"][number] = {
      ref,
      preservedJobIds: [],
      preservedBindings: [],
      preservedTriageSources: [],
    }
    if (cutoff === undefined) return scope
    const db = this.database()
    const bindings = this.newerRequests(ref, cutoff).flatMap((source) =>
      source.binding ? [source.binding] : [],
    )
    for (const row of db.prepare("SELECT * FROM jobs WHERE issue_key = ?").all(key(ref))) {
      const job = this.readJob(row)
      if (
        !sameRef(job.ref, ref) ||
        !ACTIVE_STATES.includes(job.state) ||
        !job.approval.request ||
        job.approval.request.createdAt <= cutoff
      )
        continue
      const proposal = db
        .prepare("SELECT json FROM proposals WHERE revision = ? AND valid = 1")
        .get(job.proposalRevision)
      if (!proposal) continue
      const value = parseRecord(proposalSchema, proposal.json, "proposal")
      if (!sameRef(value.ref, ref)) continue
      scope.preservedJobIds.push(job.id)
      bindings.push(requestBinding(value))
    }
    const proposal = this.proposal(ref)
    const review = this.review(ref)
    const contexts = [
      ...(proposal ? [requestBinding(proposal)] : []),
      ...(review ? [requestBinding(review)] : []),
    ]
    for (const binding of bindings) {
      if (
        contexts.some((context) => stable(context) === stable(binding)) &&
        !scope.preservedBindings.some((previous) => stable(previous) === stable(binding))
      )
        scope.preservedBindings.push(binding)
    }
    return scope
  }

  private obsoleteChange(payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null) return false
    const ref = refSchema.safeParse((payload as Record<string, unknown>).ref)
    if (!ref.success) return false
    const cutoff = changeCutoff(payload, ref.data)
    if (cutoff === undefined) return false
    const scope = this.revocationScope(ref.data, cutoff)
    this.preserveTriageBindings(scope, cutoff)
    return (
      this.newerRequests(ref.data, cutoff).length > 0 ||
      scope.preservedJobIds.length > 0 ||
      scope.preservedBindings.length > 0 ||
      scope.preservedTriageSources.length > 0
    )
  }

  acceptDelivery(
    id: string,
    payload: unknown,
    revoked: IssueRef[] = [],
    reviews: ReviewInvalidation[] = [],
  ): DeliveryIntakeResult {
    const db = this.database()
    deliveryId(id)
    return this.transaction(() => {
      const result: DeliveryIntakeResult = { queued: false, revocations: [], reviews: [] }
      if (db.prepare("SELECT id FROM deliveries WHERE id = ?").get(id)) return result
      const json = encodePayload(payload)
      const now = Date.now()
      const retriage = retriageSource(payload)
      const direct = requestSource(payload)
      const source = retriage ?? direct
      const duplicate = retriage
        ? db
            .prepare("SELECT id FROM deliveries WHERE request_key = ? LIMIT 1")
            .get(retriage.requestKey) !== undefined ||
          retriage.createdAt <= this.triageEpoch().labelAfter
        : direct !== undefined && this.duplicateRequest(direct)
      const obsolete = !duplicate && this.obsoleteChange(payload)
      db.prepare(
        "INSERT INTO deliveries(id,payload,status,accepted_at,available_at,request_key) VALUES(?,?,?,?,?,?)",
      ).run(
        id,
        duplicate || obsolete ? null : json,
        duplicate || obsolete ? "complete" : "pending",
        now,
        now,
        source?.requestKey ?? null,
      )
      if (duplicate) return result
      result.queued = !obsolete
      // Dispatch can be obsolete while its revocation of older authority is not.
      for (const ref of revoked) {
        const cutoff = changeCutoff(payload, ref)
        const scope = this.revocationScope(ref, cutoff)
        for (const row of db
          .prepare("SELECT id,payload FROM deliveries WHERE status = 'pending' AND id != ?")
          .all(id)) {
          if (typeof row.payload !== "string") continue
          const pending = JSON.parse(row.payload)
          if (
            typeof pending !== "object" ||
            pending === null ||
            (!pending.request && !pending.retriage)
          )
            continue
          const pendingRef = refSchema.safeParse(pending.ref)
          if (!pendingRef.success || !sameRef(ref, pendingRef.data)) continue
          const pendingSource = retriageSource(pending) ?? requestSource(pending)
          const actor = actorSchema.safeParse(pending.actor)
          if (
            cutoff !== undefined &&
            pendingSource &&
            pendingSource.createdAt > cutoff &&
            actor.success &&
            actor.data.type === "User"
          )
            continue
          db.prepare("UPDATE deliveries SET status = 'complete', payload = NULL WHERE id = ?").run(
            row.id as string,
          )
        }
        this.invalidateRecords(ref, scope)
        // Read-only requests may preserve a review, never proposal or job authority.
        this.preserveTriageBindings(scope, cutoff)
        this.revokeInvalidatedTriage(ref, scope, cutoff)
        result.revocations.push(scope)
      }
      for (const invalidation of reviews) {
        const { ref, reason } = validate(
          z.strictObject({
            ref: refSchema,
            reason: z.enum(["changed", "closed", "skipped", "unavailable"]),
          }),
          invalidation,
          "review invalidation",
        )
        const cutoff = changeCutoff(payload, ref)
        const scope = this.revocationScope(ref, cutoff)
        this.preserveTriageBindings(scope, cutoff)
        this.revokeInvalidatedTriage(ref, scope, cutoff)
        const row = db.prepare("SELECT * FROM reviews WHERE issue_key = ?").get(key(ref))
        if (!row) continue
        const current = this.readReview(row)
        if (!sameRef(current.ref, ref)) throw new Error("Inconsistent review identity")
        if (
          scope.preservedTriageSources.length > 0 ||
          scope.preservedBindings.some(
            (binding) => stable(binding) === stable(requestBinding(current)),
          )
        )
          continue
        result.reviews.push({ ref, reason, revision: this.storeStaleReview(current, reason, now) })
      }
      return result
    })
  }

  private storeStaleReview(
    current: Review,
    reason: ReviewInvalidation["reason"],
    now: number,
  ): string {
    const review = validate(reviewSchema, staleReview(current, reason, now), "review")
    this.database()
      .prepare("UPDATE reviews SET revision = ?, state = ?, json = ? WHERE issue_key = ?")
      .run(review.revision, review.state, JSON.stringify(review), key(current.ref))
    return review.revision
  }

  deliveries(): { id: string; payload: unknown }[] {
    return this.database()
      .prepare(
        "SELECT id,payload FROM deliveries WHERE status = 'pending' AND available_at <= ? ORDER BY accepted_at,id LIMIT 100",
      )
      .all(Date.now())
      .map((row) => {
        if (typeof row.id !== "string" || typeof row.payload !== "string")
          throw new Error("Invalid persisted delivery record")
        deliveryId(row.id)
        let payload: unknown
        try {
          payload = JSON.parse(row.payload)
        } catch {
          throw new Error("Invalid persisted delivery record")
        }
        // Apply the same bounds and credential checks to persisted input.
        encodePayload(payload)
        return { id: row.id, payload }
      })
  }

  bindRequest(id: string, binding: RequestBinding): void {
    deliveryId(id)
    this.transaction(() => {
      const db = this.database()
      const row = db
        .prepare("SELECT payload FROM deliveries WHERE id = ? AND status = 'pending'")
        .get(id)
      if (typeof row?.payload !== "string") throw new Error("job_cancelled")
      const payload = JSON.parse(row.payload)
      const source = requestSource(payload)
      if (
        !source ||
        this.retiredCodingRequest(source.ref, source.createdAt) ||
        (payload.requestBinding && stable(payload.requestBinding) !== stable(binding))
      )
        throw new Error("proposal_stale")
      db.prepare("UPDATE deliveries SET payload = ? WHERE id = ? AND status = 'pending'").run(
        encodePayload({ ...payload, requestBinding: binding }),
        id,
      )
    })
  }

  retireCodingRequests(ref: IssueRef, cutoff: number): void {
    const before = validate(timestamp, cutoff, "request retirement cutoff")
    if (before > Date.now()) throw new Error("Invalid request retirement cutoff")
    this.transaction(() => {
      this.retireCodingReceipts(ref, before)
      this.revokeTriageAdmissions(
        ref,
        (admission) => !!admission.candidateKey || admission.createdAt > before,
      )
    })
  }

  private retireCodingReceipts(ref: IssueRef, before: number): void {
    const db = this.database()
    const issueKey = key(ref)
    db.prepare(`INSERT INTO triage_coding_cutoffs(issue_key,reject_before) VALUES(?,?)
      ON CONFLICT(issue_key) DO UPDATE SET reject_before = MAX(triage_coding_cutoffs.reject_before,excluded.reject_before)`).run(
      issueKey,
      before,
    )
    for (const row of db
      .prepare("SELECT id,payload FROM deliveries WHERE status = 'pending'")
      .all()) {
      if (typeof row.payload !== "string") continue
      const source = requestSource(JSON.parse(row.payload))
      if (!source || key(source.ref) !== issueKey || source.createdAt > before) continue
      db.prepare(
        "UPDATE deliveries SET status = 'complete', payload = NULL, request_key = ? WHERE id = ?",
      ).run(source.requestKey, row.id as string)
    }
  }

  completeDelivery(id: string): void {
    const db = this.database()
    deliveryId(id)
    db.prepare("UPDATE deliveries SET status = 'complete', payload = NULL WHERE id = ?").run(id)
  }

  blockedUntil(): number {
    const row = this.database()
      .prepare("SELECT COALESCE(MAX(global_until),0) AS deadline FROM deliveries")
      .get()
    return validate(timestamp, row?.deadline, "GitHub cooldown")
  }

  deferDelivery(id: string, delayMs: number, scope: "global" | "issue" = "global"): void {
    const db = this.database()
    deliveryId(id)
    const deadline = Date.now() + delayMs
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || !Number.isSafeInteger(deadline))
      throw new Error("Invalid delivery delay")
    db.prepare(`UPDATE deliveries SET attempts = attempts + 1, available_at = ?,
      global_until = MAX(global_until, ?),
      status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
      WHERE id = ? AND status = 'pending' AND attempts < ?`).run(
      deadline,
      scope === "global" ? deadline : 0,
      MAX_DELIVERY_ATTEMPTS,
      id,
      MAX_DELIVERY_ATTEMPTS,
    )
  }

  proposals(): Proposal[] {
    return this.database()
      .prepare(`SELECT p.json FROM proposals p
      JOIN proposal_heads h ON h.revision = p.revision WHERE p.valid = 1`)
      .all()
      .map((row) => parseRecord(proposalSchema, row.json, "proposal"))
  }

  proposal(ref: IssueRef): Proposal | undefined {
    const row = this.database()
      .prepare(`SELECT p.revision,p.issue_key,p.json FROM proposals p
      JOIN proposal_heads h ON h.revision = p.revision WHERE h.issue_key = ? AND p.valid = 1`)
      .get(key(ref))
    if (!row) return undefined
    const proposal = parseRecord(proposalSchema, row.json, "proposal")
    if (
      row.revision !== proposal.revision ||
      row.issue_key !== key(proposal.ref) ||
      !sameRef(proposal.ref, ref)
    )
      throw new Error("Inconsistent proposal identity")
    return proposal
  }

  saveProposal(proposal: Proposal): void {
    const db = this.database()
    const value = validate(proposalSchema, proposal, "proposal")
    this.transaction(() => {
      this.reserveAutomaticTriage(value.ref)
      const previousRow = db
        .prepare("SELECT json,valid FROM proposals WHERE revision = ?")
        .get(value.revision)
      if (previousRow) {
        const previous = parseRecord(proposalSchema, previousRow.json, "proposal")
        const {
          commentIntent: oldIntent,
          commentRetryAt: _oldRetryAt,
          commentId: oldComment,
          publishedAt: oldPublished,
          ...oldScope
        } = previous
        const { commentIntent, commentRetryAt: _retryAt, commentId, publishedAt, ...scope } = value
        if (
          previousRow.valid !== 1 ||
          stable(oldScope) !== stable(scope) ||
          (oldIntent === true && commentIntent !== true) ||
          (oldComment !== undefined && oldComment !== commentId) ||
          (oldPublished !== undefined && oldPublished !== publishedAt)
        )
          throw new Error("Proposal authority is immutable")
        db.prepare("UPDATE proposals SET json = ? WHERE revision = ?").run(
          JSON.stringify(value),
          value.revision,
        )
        return
      }
      this.invalidateRecords(value.ref)
      db.prepare("INSERT INTO proposals(revision,issue_key,json,valid) VALUES(?,?,?,1)").run(
        value.revision,
        key(value.ref),
        JSON.stringify(value),
      )
      db.prepare(
        "INSERT INTO proposal_heads(issue_key,revision) VALUES(?,?) ON CONFLICT(issue_key) DO UPDATE SET revision = excluded.revision",
      ).run(key(value.ref), value.revision)
    })
  }

  invalidate(ref: IssueRef): void {
    this.transaction(() => this.invalidateRecords(ref))
  }

  private invalidateRecords(
    ref: IssueRef,
    scope?: DeliveryIntakeResult["revocations"][number],
  ): void {
    const db = this.database()
    const issueKey = key(ref)
    for (const row of db
      .prepare("SELECT revision,json FROM proposals WHERE issue_key = ? AND valid = 1")
      .all(issueKey)) {
      const proposal = parseRecord(proposalSchema, row.json, "proposal")
      if (
        scope?.preservedBindings.some(
          (binding) => stable(binding) === stable(requestBinding(proposal)),
        )
      )
        continue
      db.prepare("UPDATE proposals SET valid = 0 WHERE revision = ?").run(row.revision as string)
    }
    for (const row of db.prepare("SELECT * FROM jobs WHERE issue_key = ?").all(issueKey)) {
      const job = this.readJob(row)
      if (ACTIVE_STATES.includes(job.state) && !scope?.preservedJobIds.includes(job.id)) {
        this.updateJob({
          ...job,
          state: "cancelled",
          updatedAt: Math.max(Date.now(), job.updatedAt),
          error: "authority_revoked",
        })
      }
    }
  }

  claim(proposal: Proposal, approval: Approval, requestDeliveryId?: string): Job | undefined {
    const db = this.database()
    const proposalResult = proposalSchema.safeParse(proposal)
    const approvalResult = approvalSchema.safeParse(approval)
    if (!proposalResult.success || !approvalResult.success) return undefined
    const value = proposalResult.data
    const authority = approvalResult.data
    return this.transaction(() => {
      const stored = this.proposal(value.ref)
      const now = Date.now()
      if (authority.request) {
        if (!requestDeliveryId) return undefined
        deliveryId(requestDeliveryId)
        const row = db
          .prepare("SELECT payload FROM deliveries WHERE id = ? AND status = 'pending'")
          .get(requestDeliveryId)
        if (typeof row?.payload !== "string") return undefined
        const pending = JSON.parse(row.payload)
        const pendingRef = refSchema.safeParse(pending.ref)
        const binding = {
          fingerprint: value.fingerprint,
          baseSha: value.baseSha,
          baseBranch: value.baseBranch,
          policyHash: value.policyHash,
        }
        if (
          !pendingRef.success ||
          this.retiredCodingRequest(value.ref, authority.request.createdAt) ||
          pending.retriage !== undefined ||
          !sameRef(pendingRef.data, value.ref) ||
          pending.actor === undefined ||
          pending.request === undefined ||
          pending.requestBinding === undefined ||
          stable(pending.actor) !== stable(authority.actor) ||
          stable(pending.requestBinding) !== stable(binding) ||
          (authority.request.kind === "comment"
            ? stable(pending.request) !== stable(authority.request)
            : pending.request?.kind !== "assignment" ||
              pending.request.assigneeId !== authority.request.assigneeId ||
              pending.request.createdAt !== authority.request.createdAt)
        )
          return undefined
      }
      if (
        !stored ||
        stable(stored) !== stable(value) ||
        value.commentId === undefined ||
        value.publishedAt === undefined ||
        value.createdAt > now ||
        value.expiresAt <= now ||
        value.publishedAt > now ||
        authority.proposalRevision !== value.revision ||
        authority.actor.type !== "User" ||
        !["write", "maintain", "admin"].includes(authority.permission) ||
        (authority.request
          ? authority.createdAt !== authority.request.createdAt ||
            authority.createdAt + 86_400_000 <= now ||
            authority.eventId !==
              (authority.request.kind === "comment"
                ? `comment:${authority.request.commentId}`
                : `assignment:${authority.request.eventId}`)
          : authority.createdAt <= value.publishedAt) ||
        authority.createdAt >= value.expiresAt ||
        authority.createdAt > now ||
        db.prepare("SELECT event_id FROM approvals WHERE event_id = ?").get(authority.eventId) ||
        db
          .prepare(
            "SELECT id FROM jobs WHERE state IN ('approved','working','validating','publishing') LIMIT 1",
          )
          .get()
      )
        return undefined
      const history = db
        .prepare("SELECT * FROM jobs WHERE issue_key = ?")
        .all(key(value.ref))
        .map((row) => this.readJob(row))
      if (
        history.some(
          (job) =>
            ACTIVE_STATES.includes(job.state) ||
            job.state === "pr_ready" ||
            job.publication?.prNumber !== undefined,
        )
      )
        return undefined
      const job: Job = {
        id: randomUUID(),
        ref: { ...value.ref },
        proposalRevision: value.revision,
        approval: authority,
        state: "approved",
        createdAt: now,
        updatedAt: now,
      }
      db.prepare(
        "INSERT INTO approvals(event_id,issue_key,proposal_revision,json) VALUES(?,?,?,?)",
      ).run(authority.eventId, key(value.ref), value.revision, JSON.stringify(authority))
      db.prepare(
        "INSERT INTO jobs(id,issue_key,proposal_revision,approval_event_id,state,json) VALUES(?,?,?,?,?,?)",
      ).run(
        job.id,
        key(job.ref),
        job.proposalRevision,
        job.approval.eventId,
        job.state,
        JSON.stringify(job),
      )
      return job
    })
  }

  private readJob(row: Row): Job {
    const job = parseRecord(jobSchema, row.json, "job")
    if (
      row.id !== job.id ||
      row.issue_key !== key(job.ref) ||
      row.state !== job.state ||
      row.proposal_revision !== job.proposalRevision ||
      row.approval_event_id !== job.approval.eventId
    )
      throw new Error("Inconsistent job identity")
    return job
  }

  job(id: string): Job | undefined {
    const row = this.database().prepare("SELECT * FROM jobs WHERE id = ?").get(id)
    return row ? this.readJob(row) : undefined
  }

  jobs(): Job[] {
    return this.database()
      .prepare("SELECT * FROM jobs ORDER BY rowid")
      .all()
      .map((row) => this.readJob(row))
  }

  saveJob(job: Job): void {
    const db = this.database()
    const value = validate(jobSchema, job, "job")
    this.transaction(() => {
      const previous = this.job(value.id)
      if (!previous) throw new Error("Jobs must be created by an approval claim")
      if (
        !sameRef(previous.ref, value.ref) ||
        previous.proposalRevision !== value.proposalRevision ||
        stable(previous.approval) !== stable(value.approval) ||
        previous.createdAt !== value.createdAt ||
        value.updatedAt < previous.updatedAt
      )
        throw new Error("Job authority is immutable")
      if (previous.state !== value.state && !TRANSITIONS[previous.state].includes(value.state))
        throw new Error("Invalid job state transition")
      if (previous.notified === true && value.notified !== true)
        throw new Error("Terminal notification is immutable")
      if (previous.artifact && stable(previous.artifact) !== stable(value.artifact))
        throw new Error("Job artifact is immutable")
      if (previous.publication) {
        const publication = value.publication
        if (
          !publication ||
          Object.entries(previous.publication).some(([field, entry]) => {
            if (
              entry === undefined ||
              field === "prRetryAt" ||
              (field === "prIntent" && entry === false)
            )
              return false
            const next = publication[field as keyof typeof publication]
            return next === undefined || stable(entry) !== stable(next)
          })
        )
          throw new Error("Publication identity is immutable")
      }
      if (
        (value.state === "working" ||
          value.state === "validating" ||
          value.state === "publishing") &&
        !this.proposal(value.ref)
      )
        throw new Error("Proposal authority was revoked")
      db.prepare("UPDATE jobs SET state = ?, json = ? WHERE id = ?").run(
        value.state,
        JSON.stringify(value),
        value.id,
      )
    })
  }

  private updateJob(job: Job): void {
    this.database()
      .prepare("UPDATE jobs SET state = ?, json = ? WHERE id = ?")
      .run(job.state, JSON.stringify(job), job.id)
  }

  cancel(ref: IssueRef): void {
    this.transaction(() => {
      this.invalidateRecords(ref)
      this.revokeTriageAdmissions(ref)
    })
  }
}
