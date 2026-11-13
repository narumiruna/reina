import { createHash, randomUUID } from "node:crypto"
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { safePath } from "../triage/policy.js"
import {
  REVIEW_RETRY_DELAYS,
  type Review,
  type ReviewInvalidation,
  reviewSchema,
  staleReview,
} from "../triage/review.js"
import { triageSchema } from "../triage/schema.js"
import type { Approval, IssueRef, Job, JobState, Proposal } from "../types.js"

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
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
const approvalSchema: z.ZodType<Approval> = z.strictObject({
  eventId: boundedText(200),
  actor: actorSchema,
  proposalRevision: digest,
  createdAt: timestamp,
  permission: boundedText(30),
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
    if (version === 5) return
    if (![0, 1, 2, 3, 4].includes(Number(version)))
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
      const db = this.database()
      for (const row of db.prepare("SELECT * FROM reviews WHERE state = 'running'").all()) {
        const review = this.readReview(row)
        const recovered = validate(
          reviewSchema,
          {
            ...review,
            state: review.attempts < 3 ? "pending" : "failed",
            updatedAt: Math.max(Date.now(), review.updatedAt),
            nextAttemptAt:
              review.attempts < 3
                ? Math.max(
                    review.nextAttemptAt,
                    Date.now() + (REVIEW_RETRY_DELAYS[review.attempts - 1] ?? 0),
                  )
                : 0,
            error: "triage_interrupted",
          },
          "review",
        )
        db.prepare("UPDATE reviews SET state = ?, json = ? WHERE issue_key = ?").run(
          recovered.state,
          JSON.stringify(recovered),
          key(recovered.ref),
        )
      }
    })
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

  saveReview(review: Review, expectedRevision?: string): boolean {
    const db = this.database()
    const value = validate(reviewSchema, review, "review")
    if (expectedRevision !== undefined) validate(z.uuid(), expectedRevision, "review revision")
    return this.transaction(() => {
      const row = db.prepare("SELECT * FROM reviews WHERE issue_key = ?").get(key(value.ref))
      if (!row) {
        if (expectedRevision !== undefined) return false
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

  acceptDelivery(
    id: string,
    payload: unknown,
    revoked: IssueRef[] = [],
    reviews: ReviewInvalidation[] = [],
  ): boolean {
    const db = this.database()
    deliveryId(id)
    return this.transaction(() => {
      if (db.prepare("SELECT id FROM deliveries WHERE id = ?").get(id)) return false
      const json = encodePayload(payload)
      const now = Date.now()
      db.prepare(
        "INSERT INTO deliveries(id,payload,status,accepted_at,available_at) VALUES(?,?,'pending',?,?)",
      ).run(id, json, now, now)
      // A received revocation must survive a crash before dispatch or publication recovery.
      for (const ref of revoked) this.invalidateRecords(ref)
      for (const invalidation of reviews) {
        const { ref, reason } = validate(
          z.strictObject({
            ref: refSchema,
            reason: z.enum(["changed", "closed", "skipped", "unavailable"]),
          }),
          invalidation,
          "review invalidation",
        )
        const row = db.prepare("SELECT * FROM reviews WHERE issue_key = ?").get(key(ref))
        if (!row) continue
        const current = this.readReview(row)
        if (!sameRef(current.ref, ref)) throw new Error("Inconsistent review identity")
        const review = validate(reviewSchema, staleReview(current, reason, now), "review")
        db.prepare("UPDATE reviews SET revision = ?, state = ?, json = ? WHERE issue_key = ?").run(
          review.revision,
          review.state,
          JSON.stringify(review),
          key(ref),
        )
      }
      return true
    })
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

  private invalidateRecords(ref: IssueRef): void {
    const db = this.database()
    const issueKey = key(ref)
    db.prepare("UPDATE proposals SET valid = 0 WHERE issue_key = ?").run(issueKey)
    for (const row of db.prepare("SELECT * FROM jobs WHERE issue_key = ?").all(issueKey)) {
      const job = this.readJob(row)
      if (ACTIVE_STATES.includes(job.state)) {
        this.updateJob({
          ...job,
          state: "cancelled",
          updatedAt: Math.max(Date.now(), job.updatedAt),
          error: "authority_revoked",
        })
      }
    }
  }

  claim(proposal: Proposal, approval: Approval): Job | undefined {
    const db = this.database()
    const proposalResult = proposalSchema.safeParse(proposal)
    const approvalResult = approvalSchema.safeParse(approval)
    if (!proposalResult.success || !approvalResult.success) return undefined
    const value = proposalResult.data
    const authority = approvalResult.data
    return this.transaction(() => {
      const stored = this.proposal(value.ref)
      const now = Date.now()
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
        authority.createdAt <= value.publishedAt ||
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
    this.invalidate(ref)
  }
}
