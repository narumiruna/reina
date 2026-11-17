import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { backup, DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { loadConfig, loadRuntimeConfig } from "../src/config.js"
import { type RequestBinding, Store } from "../src/jobs/store.js"
import { dispatchInputSchema, dispatchSettingsSchema } from "../src/settings/dispatch.js"
import {
  allowedPath,
  eligible,
  fingerprint,
  makeProposal,
  policyHash,
  safePath,
} from "../src/triage/policy.js"
import type { Review } from "../src/triage/review.js"
import { triageSchema } from "../src/triage/schema.js"
import type {
  Approval,
  Artifact,
  Config,
  Issue,
  Job,
  JobState,
  Proposal,
  Snapshot,
  TriageDecision,
} from "../src/types.js"

const image = `ghcr.io/example/reina@sha256:${"d".repeat(64)}`
let directory: string
const stores: Store[] = []
const children: ChildProcess[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "reina-core-"))
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      child.kill("SIGKILL")
      await exited
    }
  }
  for (const store of stores.splice(0)) store.close()
  rmSync(directory, { recursive: true, force: true })
})

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ID: "123",
    WEBHOOK_SECRET: "fixture-webhook-secret-32-characters",
    REINA_REPOSITORY: "example/project",
    REINA_REPOSITORY_ID: "456",
    REINA_INSTALLATION_ID: "789",
    REINA_STATE_DIR: join(directory, "state"),
    REINA_WORKER_IMAGE: image,
    REINA_FORBIDDEN_PATHS:
      '["src/identity/**","src/permissions/**","src/security/**","src/release/**","src/platform/**"]',
    ...overrides,
  }
}
function config(): Config {
  return {
    ...loadConfig(environment()),
    model: "openai/gpt-test",
    modelUrl: "https://model.example/v1",
    modelKey: "fixture-model-key",
  }
}
function decision(overrides: Partial<TriageDecision> = {}): TriageDecision {
  return {
    eligible: true,
    category: "documentation",
    reason: "The usage example has an incorrect command name.",
    proposedFix: "Correct the command name in the usage example.",
    affectedFiles: ["README.md"],
    verificationPlan: ["Run the trusted CI checks and inspect the example."],
    requiresHumanDecision: false,
    risks: [],
    ...overrides,
  }
}
function issue(number = 1): Issue {
  return {
    ref: { ...config().repository, number, issueId: 1_000 + number },
    title: "Correct the usage example",
    body: "Replace npn with npm in the example.",
    comments: [
      { id: 11, authorId: 2, body: "The command name is incorrect." },
      { id: 12, authorId: 99, body: "Own proposal comment" },
    ],
    labels: [],
    state: "open",
    pullRequest: false,
  }
}
function snapshot(): Snapshot {
  return {
    branch: "main",
    sha: "a".repeat(40),
    files: {
      "README.md": { mode: "100644", content: Buffer.from("npn run ci\n") },
      "package-lock.json": { mode: "100644", content: Buffer.from('{"lockfileVersion":3}') },
    },
  }
}
function proposal(number = 1, now = Date.now() - 10_000): Proposal {
  return {
    ...makeProposal(issue(number), snapshot(), decision(), config(), 99, now),
    commentIntent: true,
    commentId: 100 + number,
    publishedAt: now + 1_000,
  }
}
function approval(value: Proposal, eventId = "approval-1"): Approval {
  return {
    eventId,
    actor: { id: 50, login: "maintainer", type: "User" },
    proposalRevision: value.revision,
    createdAt: required(value.publishedAt) + 1_000,
    permission: "write",
  }
}
function acceptRequest(store: Store, value: Proposal, authority: Approval, id = "direct-source") {
  const request = required(authority.request)
  const candidate =
    request.kind === "comment"
      ? request
      : { kind: request.kind, assigneeId: request.assigneeId, createdAt: request.createdAt }
  store.acceptDelivery(id, {
    kind: "issue",
    ref: value.ref,
    actor: authority.actor,
    action: request.kind === "comment" ? "created" : "assigned",
    material: request.kind === "comment",
    cancel: false,
    request: candidate,
    requestIssueHash: value.fingerprint,
    requestBinding: {
      fingerprint: value.fingerprint,
      baseSha: value.baseSha,
      baseBranch: value.baseBranch,
      policyHash: value.policyHash,
    },
  })
  return id
}

function directApproval(
  value: Proposal,
  kind: "comment" | "assignment",
  sourceId = 300,
  createdAt = value.createdAt - 1_000,
): Approval {
  return {
    ...approval(value),
    eventId: `${kind}:${sourceId}`,
    createdAt,
    request:
      kind === "comment"
        ? { kind, commentId: sourceId, bodyHash: "c".repeat(64), createdAt, updatedAt: createdAt }
        : { kind, eventId: String(sourceId), assigneeId: 99, createdAt },
  }
}

function binding(value: Proposal): RequestBinding {
  return {
    fingerprint: value.fingerprint,
    baseSha: value.baseSha,
    baseBranch: value.baseBranch,
    policyHash: value.policyHash,
  }
}

function pendingReview(value: Proposal): Review {
  return {
    ref: value.ref,
    revision: randomUUID(),
    binding: { ...binding(value), protocolRevision: "fixture-review-v1" },
    state: "pending",
    attempts: 0,
    createdAt: value.createdAt,
    updatedAt: value.createdAt,
    nextAttemptAt: 0,
  }
}

function inspect<T>(operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(directory, "state", "reina.sqlite"), { readOnly: true })
  try {
    return operation(db)
  } finally {
    db.close()
  }
}

function artifact(): Artifact {
  return {
    files: [
      {
        path: "README.md",
        content: Buffer.from("npm run ci\n").toString("base64"),
        mode: "100644",
      },
    ],
    diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-npn run ci\n+npm run ci\n",
    hash: "e".repeat(64),
    verification: [{ argv: ["npm", "run", "ci"], exitCode: 0, durationMs: 10, image }],
  }
}
function openStore(): Store {
  const store = new Store(join(directory, "state"))
  stores.push(store)
  return store
}
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Required fixture value is missing")
  return value
}

function claim(store: Store, number = 1): Job {
  const value = proposal(number)
  store.saveProposal(value)
  const job = store.claim(value, approval(value, `approval-${number}`))
  expect(job).toBeDefined()
  return required(job)
}
function advance(store: Store, job: Job, state: JobState, extra: Partial<Job> = {}): Job {
  const next = { ...job, state, updatedAt: job.updatedAt + 1, ...extra }
  store.saveJob(next)
  return next
}
function publishing(store: Store, job: Job): Job {
  const working = advance(store, job, "working")
  const validating = advance(store, working, "validating")
  return advance(store, validating, "publishing", { artifact: artifact() })
}

// All credentials and endpoints are in-memory fixtures. No network is used.

describe("atomic revocation and persistent GitHub cooldown", () => {
  test("revocation and inbox acceptance commit together before restart publication recovery", () => {
    const store = openStore()
    const job = publishing(store, claim(store))
    expect(store.proposals()).toHaveLength(1)
    expect(store.acceptDelivery("revoke-before-crash", { kind: "revoke" }, [job.ref]).queued).toBe(
      true,
    )
    store.close()
    const restored = openStore()
    expect(restored.job(job.id)?.state).toBe("cancelled")
    expect(restored.proposal(job.ref)).toBeUndefined()
    expect(restored.proposals()).toEqual([])
    expect(restored.deliveries()).toHaveLength(1)
  })

  test("material revocation durably consumes older direct deliveries but keeps unrelated work", () => {
    let store = openStore()
    const ref = issue().ref
    const request = { kind: "assignment", assigneeId: 99, createdAt: Date.now() }
    store.acceptDelivery("older-direct", { kind: "issue", ref, request })
    store.deferDelivery("older-direct", 60_000, "issue")
    store.acceptDelivery("other-direct", { kind: "issue", ref: issue(2).ref, request })
    store.acceptDelivery("legacy-work", { kind: "issue", ref })
    store.acceptDelivery("material-revocation", { kind: "issue", ref, material: true }, [ref])
    store.close()
    store = openStore()
    expect(store.acceptDelivery("older-direct", { kind: "issue", ref, request }).queued).toBe(false)
    expect(
      store
        .deliveries()
        .map((delivery) => delivery.id)
        .sort(),
    ).toEqual(["legacy-work", "material-revocation", "other-direct"])
  })

  test("older signed changes preserve newer deferred requests, but same-time changes revoke", () => {
    const store = openStore()
    const ref = issue().ref
    const createdAt = Date.now()
    store.acceptDelivery("newer-request", {
      kind: "issue",
      ref,
      actor: { id: 42, login: "maintainer", type: "User" },
      request: { kind: "assignment", assigneeId: 99, createdAt },
    })
    store.deferDelivery("newer-request", 60_000, "issue")
    expect(
      store.acceptDelivery(
        "older-edit",
        {
          kind: "issue",
          ref,
          material: true,
          changedAt: createdAt - 1,
        },
        [ref],
      ).queued,
    ).toBe(false)
    expect(
      store.acceptDelivery(
        "ambiguous-edit",
        {
          kind: "issue",
          ref,
          material: true,
          changedAt: createdAt,
        },
        [ref],
      ).queued,
    ).toBe(true)
    store.close()
    const restored = openStore()
    vi.setSystemTime(createdAt + 60_001)
    expect(restored.deliveries().map((item) => item.id)).toEqual(["ambiguous-edit"])
  })

  test("invalid revocation rolls back both inbox and authority changes", () => {
    const store = openStore()
    const job = claim(store)
    expect(() =>
      store.acceptDelivery("rollback-revoke", {}, [{ ...job.ref, issueId: -1 }]),
    ).toThrow()
    expect(store.deliveries()).toEqual([])
    expect(store.job(job.id)?.state).toBe("approved")
    expect(store.proposal(job.ref)).toBeDefined()
  })

  test("a consistent SQLite backup restores consumed approval and publication history", async () => {
    const store = openStore()
    const proposalValue = proposal()
    store.saveProposal(proposalValue)
    const approved = approval(proposalValue)
    const job = required(store.claim(proposalValue, approved))
    publishing(store, job)
    const source = new DatabaseSync(join(directory, "state", "reina.sqlite"), { readOnly: true })
    const backupPath = join(directory, "backup.sqlite")
    try {
      await backup(source, backupPath)
    } finally {
      source.close()
    }
    store.close()
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(join(directory, "state", `reina.sqlite${suffix}`), { force: true })
    copyFileSync(backupPath, join(directory, "state", "reina.sqlite"))
    const restored = openStore()
    expect(restored.job(job.id)?.state).toBe("publishing")
    expect(restored.proposal(job.ref)?.revision).toBe(proposalValue.revision)
    expect(restored.claim(proposalValue, approved)).toBeUndefined()
  })

  test("long Retry-After applies to all dispatch and survives restart", () => {
    const store = openStore()
    const now = Date.now()
    store.acceptDelivery("cooldown", {})
    store.deferDelivery("cooldown", 2 * 86_400_000)
    const deadline = store.blockedUntil()
    expect(deadline).toBeGreaterThanOrEqual(now + 2 * 86_400_000)
    store.completeDelivery("cooldown")
    expect(store.blockedUntil()).toBe(deadline)
    store.close()
    expect(openStore().blockedUntil()).toBe(deadline)
  })
})
describe("durable request sources and selective revocation", () => {
  test.each([
    ["comment", "complete"],
    ["assignment", "complete"],
    ["comment", "revoked"],
    ["assignment", "revoked"],
    ["comment", "exhausted"],
    ["assignment", "exhausted"],
  ] as const)("%s source stays consumed after %s and restart", (kind, outcome) => {
    let store = openStore()
    const value = proposal()
    const authority = directApproval(value, kind)
    const id = acceptRequest(store, value, authority)
    const payload = required(store.deliveries().find((item) => item.id === id)).payload as Record<
      string,
      unknown
    >
    store.deferDelivery(id, 0, "issue")
    if (outcome === "complete") {
      expect(() => store.bindRequest(id, { ...binding(value), baseSha: "e".repeat(40) })).toThrow(
        "proposal_stale",
      )
      store.completeDelivery(id)
    } else if (outcome === "revoked") {
      store.acceptDelivery("material", { kind: "issue", ref: value.ref, material: true }, [
        value.ref,
      ])
    } else {
      for (let attempt = 1; attempt < 8; attempt++) store.deferDelivery(id, 0, "issue")
    }
    store.close()
    store = openStore()
    const changed = {
      ...payload,
      actor: { ...authority.actor, login: "renamed-maintainer" },
      requestIssueHash: "f".repeat(64),
      requestBinding: { ...binding(value), baseSha: "e".repeat(40) },
      ...(kind === "comment"
        ? { request: { ...required(authority.request), bodyHash: "d".repeat(64) } }
        : {}),
    }
    expect(store.acceptDelivery("different-guid", changed, [value.ref])).toEqual({
      queued: false,
      revocations: [],
      reviews: [],
    })
    expect(() => store.bindRequest("different-guid", binding(value))).toThrow("job_cancelled")
    expect(
      inspect(
        (db) => db.prepare("SELECT request_key FROM deliveries WHERE id = ?").get(id)?.request_key,
      ),
    ).toMatch(/^[a-f0-9]{64}$/)
    expect(
      inspect((db) => db.prepare("SELECT COUNT(*) AS count FROM approvals").get()?.count),
    ).toBe(0)
    const newAuthority = directApproval(value, kind, 301, authority.createdAt + 1)
    const newId = acceptRequest(store, value, newAuthority, "genuinely-new-source")
    expect(store.deliveries().some((item) => item.id === newId)).toBe(true)
  })

  test.each([false, true])(
    "a newer pending binding=%s cannot shield older sources or jobs",
    (bound) => {
      const store = openStore()
      const value = proposal(1, Date.now() - 20_000)
      const oldAuthority = directApproval(value, "comment")
      const oldId = acceptRequest(store, value, oldAuthority, "older-mention")
      const oldPayload = required(store.deliveries().find((item) => item.id === oldId)).payload
      store.saveProposal(value)
      const job = required(store.claim(value, oldAuthority, oldId))
      const review = pendingReview(value)
      store.saveReview(review)
      const cutoff = Date.now() - 10_000
      const newerAuthority = directApproval(value, "assignment", 400, cutoff + 1_000)
      const newerId = bound
        ? acceptRequest(store, value, newerAuthority, "newer-assignment")
        : "newer-assignment"
      if (!bound)
        store.acceptDelivery(newerId, {
          kind: "issue",
          ref: value.ref,
          actor: newerAuthority.actor,
          request: { kind: "assignment", assigneeId: 99, createdAt: newerAuthority.createdAt },
        })
      store.deferDelivery(oldId, 60_000, "issue")
      store.deferDelivery(newerId, 60_000, "issue")
      const result = store.acceptDelivery(
        "middle-edit",
        {
          kind: "issue",
          ref: value.ref,
          material: true,
          changedAt: cutoff,
        },
        [value.ref],
        [{ ref: value.ref, reason: "changed" }],
      )
      expect(result.queued).toBe(false)
      expect(result.revocations).toEqual([
        { ref: value.ref, preservedJobIds: [], preservedBindings: bound ? [binding(value)] : [] },
      ])
      expect(store.job(job.id)?.state).toBe("cancelled")
      expect(store.proposal(value.ref)).toEqual(bound ? value : undefined)
      expect(store.review(value.ref)?.state).toBe(bound ? "pending" : "stale")
      expect(result.reviews).toEqual(
        bound
          ? []
          : [{ ref: value.ref, reason: "changed", revision: store.review(value.ref)?.revision }],
      )
      expect(store.acceptDelivery("old-source-replay", oldPayload).queued).toBe(false)
      store.close()
      const restored = openStore()
      vi.setSystemTime(Date.now() + 60_001)
      expect(restored.deliveries().map((item) => item.id)).toEqual([newerId])
    },
  )

  test.each(["comment", "assignment"] as const)(
    "a newer active %s protects only its job and matching context",
    (kind) => {
      const store = openStore()
      const value = proposal(1, Date.now() - 20_000)
      const olderId = acceptRequest(store, value, directApproval(value, "comment"), "older-mention")
      const cutoff = Date.now() - 10_000
      const newer = directApproval(value, kind, 401, cutoff + 1_000)
      const newerId = acceptRequest(store, value, newer, "newer-source")
      store.saveProposal(value)
      const job = required(store.claim(value, newer, newerId))
      const review = pendingReview(value)
      store.saveReview(review)
      const result = store.acceptDelivery(
        "older-edit",
        {
          kind: "issue",
          ref: value.ref,
          material: true,
          changedAt: cutoff,
        },
        [value.ref],
        [{ ref: value.ref, reason: "changed" }],
      )
      expect(result).toEqual({
        queued: false,
        revocations: [
          { ref: value.ref, preservedJobIds: [job.id], preservedBindings: [binding(value)] },
        ],
        reviews: [],
      })
      expect(store.job(job.id)?.state).toBe("approved")
      expect(store.proposal(value.ref)).toEqual(value)
      expect(store.review(value.ref)).toEqual(review)
      expect(store.deliveries().map((item) => item.id)).toEqual([newerId])
      expect(() => store.bindRequest(olderId, binding(value))).toThrow("job_cancelled")
      const ambiguous = store.acceptDelivery(
        "same-time-edit",
        {
          kind: "issue",
          ref: value.ref,
          material: true,
          changedAt: newer.createdAt,
        },
        [value.ref],
        [{ ref: value.ref, reason: "changed" }],
      )
      expect(ambiguous.queued).toBe(true)
      expect(ambiguous.revocations[0]?.preservedJobIds).toEqual([])
      expect(store.job(job.id)?.state).toBe("cancelled")
      expect(store.proposal(value.ref)).toBeUndefined()
    },
  )

  test("a newer unmatched binding and historical approval do not protect old authority", () => {
    const store = openStore()
    const value = proposal(1, Date.now() - 20_000)
    store.saveProposal(value)
    const historical = directApproval(value, "assignment", 400, Date.now() - 5_000)
    const historicalId = acceptRequest(store, value, historical, "historical-source")
    const historicalJob = required(store.claim(value, historical, historicalId))
    advance(store, historicalJob, "failed", { error: "fixture_failure" })
    store.completeDelivery(historicalId)
    const oldJob = required(store.claim(value, approval(value, "older-label")))
    store.saveReview(pendingReview(value))
    const mismatched = { ...value, baseSha: "e".repeat(40) }
    acceptRequest(
      store,
      mismatched,
      directApproval(value, "assignment", 401, Date.now() - 4_000),
      "unmatched-newer-source",
    )
    const result = store.acceptDelivery(
      "middle-change",
      {
        kind: "issue",
        ref: value.ref,
        cancel: true,
        changedAt: Date.now() - 10_000,
      },
      [value.ref],
      [{ ref: value.ref, reason: "changed" }],
    )
    expect(result.revocations[0]?.preservedJobIds).toEqual([])
    expect(result.revocations[0]?.preservedBindings).toEqual([])
    expect(store.job(oldJob.id)?.state).toBe("cancelled")
    expect(store.proposal(value.ref)).toBeUndefined()
    expect(store.review(value.ref)?.state).toBe("stale")
    store.completeDelivery("unmatched-newer-source")
    expect(
      store.acceptDelivery(
        "another-old-change",
        {
          kind: "issue",
          ref: value.ref,
          cancel: true,
          changedAt: Date.now() - 10_000,
        },
        [value.ref],
      ).queued,
    ).toBe(true)
  })

  test("schema 5 migration seals lost receipts and unbound sources without rebinding known work", () => {
    vi.useFakeTimers()
    const initial = Date.now()
    vi.setSystemTime(initial)
    let store = openStore()
    const value = proposal()
    store.saveProposal(value)
    const bound = directApproval(value, "comment")
    const boundId = acceptRequest(store, value, bound, "legacy-bound")
    const boundPayload = required(store.deliveries().find((item) => item.id === boundId)).payload
    const unbound = {
      kind: "issue",
      ref: issue(2).ref,
      actor: bound.actor,
      request: { kind: "assignment", assigneeId: 99, createdAt: bound.createdAt },
    }
    store.acceptDelivery("legacy-unbound", unbound)
    const lost = { ...unbound, ref: issue(3).ref }
    store.acceptDelivery("legacy-lost", lost)
    store.completeDelivery("legacy-lost")
    const failed = { ...unbound, ref: issue(4).ref }
    store.acceptDelivery("legacy-failed", failed)
    for (let attempt = 0; attempt < 8; attempt++) store.deferDelivery("legacy-failed", 5_000)
    const deadline = store.blockedUntil()
    store.saveReview(pendingReview(value))
    store.saveScanPage(17)
    store.close()
    const db = new DatabaseSync(join(directory, "state", "reina.sqlite"))
    db.exec(`DROP TABLE request_epoch; DROP INDEX deliveries_by_request;
      ALTER TABLE deliveries DROP COLUMN request_key; PRAGMA user_version = 5;`)
    db.close()
    vi.setSystemTime(initial + 1_000)
    store = openStore()
    expect(inspect((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(6)
    expect(
      inspect((db) => db.prepare("SELECT reject_before FROM request_epoch").get()?.reject_before),
    ).toBe(initial + 1_000)
    expect(store.deliveries()).toEqual([{ id: boundId, payload: boundPayload }])
    expect(store.blockedUntil()).toBe(deadline)
    expect(store.scanPage()).toBe(17)
    expect(store.review(value.ref)?.state).toBe("pending")
    for (const [id, payload] of [
      ["replay-lost", lost],
      ["replay-unbound", unbound],
      ["replay-failed", failed],
    ] as const)
      expect(store.acceptDelivery(id, payload)).toEqual({
        queued: false,
        revocations: [],
        reviews: [],
      })
    expect(
      inspect((db) => db.prepare("SELECT COUNT(*) AS count FROM approvals").get()?.count),
    ).toBe(0)
    expect(store.claim(value, bound, boundId)).toBeDefined()
    const atCutoff = {
      ...unbound,
      ref: issue(5).ref,
      request: { ...unbound.request, createdAt: initial + 1_000 },
    }
    expect(store.acceptDelivery("unknown-at-cutoff", atCutoff).queued).toBe(false)
    vi.setSystemTime(initial + 1_001)
    const fresh = { ...unbound, request: { ...unbound.request, createdAt: initial + 1_001 } }
    expect(store.acceptDelivery("fresh-after-upgrade", fresh).queued).toBe(true)
    store.close()
    store = openStore()
    expect(store.acceptDelivery("lost-after-restart", lost).queued).toBe(false)
  })

  test("schema 5 migration rolls back its column, epoch and source cleanup together", () => {
    let store = openStore()
    const payload = {
      kind: "issue",
      ref: issue().ref,
      request: { kind: "assignment", assigneeId: 99, createdAt: Date.now() },
    }
    store.acceptDelivery("legacy-unbound", payload)
    store.acceptDelivery("corrupt", {})
    store.close()
    const path = join(directory, "state", "reina.sqlite")
    const db = new DatabaseSync(path)
    db.exec(`DROP TABLE request_epoch; DROP INDEX deliveries_by_request;
      ALTER TABLE deliveries DROP COLUMN request_key; PRAGMA user_version = 5;`)
    db.prepare("UPDATE deliveries SET payload = ? WHERE id = 'corrupt'").run("{")
    db.close()
    expect(() => openStore()).toThrow()
    expect(inspect((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(5)
    expect(
      inspect((db) =>
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'request_epoch'").get(),
      ),
    ).toBeUndefined()
    expect(
      inspect((db) =>
        db
          .prepare("PRAGMA table_info(deliveries)")
          .all()
          .some((column) => column.name === "request_key"),
      ),
    ).toBe(false)
    expect(
      inspect(
        (db) =>
          db.prepare("SELECT status FROM deliveries WHERE id = 'legacy-unbound'").get()?.status,
      ),
    ).toBe("pending")
    const repaired = new DatabaseSync(path)
    repaired.prepare("UPDATE deliveries SET payload = ? WHERE id = 'corrupt'").run("{}")
    repaired.close()
    store = openStore()
    expect(store.deliveries()).toEqual([{ id: "corrupt", payload: {} }])
  })

  test("legacy direct approvals remain source evidence without a delivery key", () => {
    const store = openStore()
    const value = proposal()
    store.saveProposal(value)
    const authority = directApproval(value, "assignment")
    const source = acceptRequest(store, value, authority)
    const payload = required(store.deliveries().find((item) => item.id === source)).payload
    required(store.claim(value, authority, source))
    store.completeDelivery(source)
    const db = new DatabaseSync(join(directory, "state", "reina.sqlite"))
    db.prepare("UPDATE deliveries SET request_key = NULL WHERE id = ?").run(source)
    db.close()
    expect(store.acceptDelivery("legacy-approval-replay", payload).queued).toBe(false)
  })
})

describe("strict configuration", () => {
  test("loads one numeric repository, safe defaults, and trusted argv without auth fields", () => {
    const value = loadConfig(environment())
    expect(value.repository).toEqual({
      owner: "example",
      name: "project",
      id: 456,
      installationId: 789,
    })
    expect(value.commands).toEqual([["npm", "run", "ci"]])
    expect(value.allowedPaths).toEqual(["README.md", "docs/**", "src/**", "tests/**"])
    expect(value).toMatchObject({
      scanIntervalMs: 900_000,
      maxIssuesPerScan: 10,
      maxConcurrentJobs: 1,
      agentTimeoutMs: 600_000,
      maxChangedFiles: 10,
      maxPatchBytes: 65_536,
    })
    expect(value).not.toHaveProperty("PRIVATE_KEY")
    expect(value).not.toHaveProperty("WEBHOOK_SECRET")
    for (const field of [
      "model",
      "modelUrl",
      "modelKey",
      "modelApi",
      "modelProvider",
      "contextWindow",
      "maxTokens",
      "modelRevision",
      "privateKey",
      "appId",
      "webhookSecret",
    ])
      expect(value).not.toHaveProperty(field)
    expect(
      loadConfig(environment({ REINA_WORKER_IMAGE: `sha256:${"a".repeat(64)}` })).image,
    ).toMatch(/^sha256:/)
    expect(
      loadConfig(
        environment({
          REINA_WORKER_IMAGE: `registry.example:5000/team/worker:1.5@sha256:${"a".repeat(64)}`,
        }),
      ).image,
    ).toContain("@sha256:")
  })

  test("legacy and persisted dispatch schemas use the same fields and defaults", () => {
    const { stateDir, ...legacy } = loadRuntimeConfig(environment())
    const saved = dispatchInputSchema.parse({
      appId: 123,
      webhookSecret: environment().WEBHOOK_SECRET,
      repository: { owner: "example", name: "project", id: 456, installationId: 789 },
      image,
      forbiddenPaths: JSON.parse(environment().REINA_FORBIDDEN_PATHS ?? "[]"),
    })
    expect(dispatchSettingsSchema.parse(saved)).toEqual(legacy)
    const { appId: _appId, webhookSecret: _secret, ...runtime } = legacy
    expect(loadConfig(environment())).toEqual({ ...runtime, stateDir })
  })

  test.each([
    ".github",
    "..repo",
    ".repo.name",
    "...",
    "-repo",
    "_repo",
    "repo.-_name",
    "a",
    "a".repeat(100),
  ])("loads repository %s identically through legacy and saved Runtime schemas", (name) => {
    const env = environment({ REINA_REPOSITORY: `example/${name}` })
    const { stateDir, ...legacy } = loadRuntimeConfig(env)
    const saved = dispatchSettingsSchema.parse(
      dispatchInputSchema.parse({
        appId: 123,
        webhookSecret: env.WEBHOOK_SECRET,
        repository: { owner: "example", name, id: 456, installationId: 789 },
        image,
        forbiddenPaths: JSON.parse(env.REINA_FORBIDDEN_PATHS ?? "[]"),
      }),
    )
    expect(saved).toEqual(legacy)
    expect(saved.repository.name).toBe(name)
    const { appId: _appId, webhookSecret: _secret, ...runtime } = saved
    expect(loadConfig(env)).toEqual({ ...runtime, stateDir })
  })

  test.each([
    "",
    ".",
    "..",
    "repo/name",
    "repo\\name",
    "repo name",
    " repo",
    "repo ",
    "repo\tname",
    "repo\n",
    "repo\0name",
    "repo\u007fname",
    "repo\u200bname",
    "repo\u00a0name",
    "répo",
    "a".repeat(101),
  ])("rejects repository name %j in both legacy and saved Runtime schemas", (name) => {
    const { stateDir: _stateDir, ...input } = loadRuntimeConfig(environment())
    expect(() => loadRuntimeConfig(environment({ REINA_REPOSITORY: `example/${name}` }))).toThrow(
      "Invalid configuration fields: REINA_REPOSITORY",
    )
    expect(
      dispatchInputSchema.safeParse({
        ...input,
        repository: { ...input.repository, name },
      }).success,
    ).toBe(false)
  })

  test.each(["mona-cat_octo", "-owner", "owner-", "a".repeat(40)])(
    "keeps repository owner %s invalid in both legacy and saved Runtime schemas",
    (owner) => {
      const { stateDir: _stateDir, ...input } = loadRuntimeConfig(environment())
      expect(() =>
        loadRuntimeConfig(environment({ REINA_REPOSITORY: `${owner}/.github` })),
      ).toThrow("Invalid configuration fields: REINA_REPOSITORY")
      expect(
        dispatchInputSchema.safeParse({
          ...input,
          repository: { ...input.repository, owner, name: ".github" },
        }).success,
      ).toBe(false)
    },
  )

  test.each([
    ["REINA_SCAN_INTERVAL_MS", "scanIntervalMs", 60_000, 86_400_000],
    ["REINA_MAX_ISSUES_PER_SCAN", "maxIssuesPerScan", 1, 10],
    ["REINA_MAX_CONCURRENT_JOBS", "maxConcurrentJobs", 1, 1],
    ["REINA_AGENT_TIMEOUT_MS", "agentTimeoutMs", 1_000, 600_000],
    ["REINA_MAX_CHANGED_FILES", "maxChangedFiles", 1, 10],
    ["REINA_MAX_PATCH_BYTES", "maxPatchBytes", 1, 65_536],
  ])("legacy %s and saved %s enforce the same numeric limits", (key, field, min, max) => {
    const { stateDir: _stateDir, ...input } = loadRuntimeConfig(environment())
    for (const value of [min, max]) {
      expect(loadRuntimeConfig(environment({ [key]: String(value) }))).toHaveProperty(field, value)
      expect(dispatchInputSchema.parse({ ...input, [field]: value })).toHaveProperty(field, value)
    }
    for (const value of [min - 1, max + 1, min + 0.5]) {
      expect(() => loadRuntimeConfig(environment({ [key]: String(value) }))).toThrow(
        `Invalid configuration fields: ${key}`,
      )
      expect(dispatchInputSchema.safeParse({ ...input, [field]: value }).success).toBe(false)
    }
  })

  test("uses process.env by default without rejecting unrelated host variables", () => {
    for (const [name, value] of Object.entries(environment())) vi.stubEnv(name, value)
    vi.stubEnv("UNRELATED_FIXTURE", "ignored")
    expect(loadConfig().repository.id).toBe(456)
  })

  test.each([
    ["APP_ID", undefined],
    ["APP_ID", "1.5"],
    ["APP_ID", "9007199254740992"],
    ["WEBHOOK_SECRET", "short"],
    ["WEBHOOK_SECRET", undefined],
    ["REINA_REPOSITORY", "one/repo,other/repo"],
    ["REINA_REPOSITORY", "https://github.com/one/repo"],
    ["REINA_REPOSITORY_ID", "0"],
    ["REINA_INSTALLATION_ID", "-2"],
    ["REINA_WORKER_IMAGE", "worker:latest"],
    ["REINA_WORKER_IMAGE", `worker@sha256:${"a".repeat(63)}`],
    ["REINA_FORBIDDEN_PATHS", undefined],
    ["REINA_FORBIDDEN_PATHS", "[]"],
    ["REINA_FORBIDDEN_PATHS", '["!src/security/**"]'],
    ["REINA_ALLOWED_PATHS", '["../outside/**"]'],
    ["REINA_ALLOWED_PATHS", '["src/**", "SRC/**"]'],
    ["REINA_ALLOWED_PATHS", '["/absolute/**"]'],
    ["REINA_ALLOWED_PATHS", '["[invalid"]'],
    ["REINA_VERIFY_COMMANDS", '["npm run ci"]'],
    ["REINA_VERIFY_COMMANDS", "[]"],
    ["REINA_VERIFY_COMMANDS", '[["npm", "run\\nci"]]'],
    ["REINA_MAX_CONCURRENT_JOBS", "2"],
    ["REINA_MAX_CHANGED_FILES", "11"],
    ["REINA_MAX_PATCH_BYTES", "65537"],
    ["REINA_AGENT_TIMEOUT_MS", "600001"],
    ["REINA_MAX_ISSUES_PER_SCAN", "11"],
    ["REINA_SCAN_INTERVAL_MS", "0"],
    ["REINA_UNKNOWN_SETTING", "1"],
  ])("rejects invalid %s (%s)", (name, value) => {
    expect(() => loadConfig(environment({ [name]: value }))).toThrow(
      /Invalid configuration fields:/,
    )
  })

  test.each([
    ["REINA_MODEL", "openai/gpt-test"],
    ["REINA_MODEL_URL", "https://model.example/v1"],
    ["REINA_MODEL_KEY", "fixture-model-key"],
  ])("rejects legacy %s even when its value was valid", (name, value) => {
    expect(() => loadConfig(environment({ [name]: value }))).toThrow(
      `Invalid configuration fields: ${name}`,
    )
  })

  test("does not require, validate, or return environment private keys", () => {
    const value = loadConfig(environment())
    for (const PRIVATE_KEY of ["", "not-a-key", "secret-private-input"])
      expect(loadConfig(environment({ PRIVATE_KEY }))).toEqual(value)
  })

  test("does not disclose credentials in configuration errors", () => {
    let message = ""
    try {
      loadConfig(
        environment({
          APP_ID: "invalid",
          PRIVATE_KEY: "secret-private-input",
          REINA_MODEL_KEY: "secret-model-input\n",
        }),
      )
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toContain("secret-private-input")
    expect(message).not.toContain("secret-model-input")
    expect(message).toBe("Invalid configuration fields: APP_ID, REINA_MODEL_KEY")
  })

  test("requires a private absolute state directory outside the checkout and its aliases", () => {
    expect(() => loadConfig(environment({ REINA_STATE_DIR: "relative/state" }))).toThrow(
      /REINA_STATE_DIR/,
    )
    expect(() =>
      loadConfig(environment({ REINA_STATE_DIR: join(process.cwd(), ".reina-state") })),
    ).toThrow(/REINA_STATE_DIR/)
    const alias = join(directory, "checkout-link")
    symlinkSync(process.cwd(), alias, "dir")
    expect(() => loadConfig(environment({ REINA_STATE_DIR: join(alias, "state") }))).toThrow(
      /REINA_STATE_DIR/,
    )
    const publicDir = join(directory, "public")
    mkdirSync(publicDir)
    chmodSync(publicDir, 0o755)
    expect(() => loadConfig(environment({ REINA_STATE_DIR: publicDir }))).toThrow(/REINA_STATE_DIR/)
    chmodSync(publicDir, 0o700)
    expect(loadConfig(environment({ REINA_STATE_DIR: publicDir })).stateDir).toBe(publicDir)
    const dangling = join(directory, "dangling")
    symlinkSync(join(directory, "missing"), dangling, "dir")
    expect(() => loadConfig(environment({ REINA_STATE_DIR: dangling }))).toThrow(/REINA_STATE_DIR/)
  })
})

describe("triage schema and policy", () => {
  test("strict bounded schema permits explicit deferral but requires evidence for eligibility", () => {
    expect(triageSchema.parse(decision())).toEqual(decision())
    expect(
      triageSchema.safeParse(
        decision({
          eligible: false,
          category: "defer",
          proposedFix: "",
          affectedFiles: [],
          verificationPlan: [],
        }),
      ).success,
    ).toBe(true)
    for (const value of [
      { ...decision(), confidence: 1 },
      { ...decision(), category: "feature" },
      { ...decision(), eligible: "true" },
      { ...decision(), reason: " " },
      { ...decision(), reason: "x".repeat(2_001) },
      decision({ proposedFix: "" }),
      decision({ affectedFiles: [] }),
      decision({ verificationPlan: [] }),
      decision({ affectedFiles: ["README.md", "README.md"] }),
      decision({ risks: Array(11).fill("risk") }),
    ])
      expect(triageSchema.safeParse(value).success).toBe(false)
  })

  test.each(["documentation", "typo", "bug", "tests", "behavior", "error-handling"] as const)(
    "permits the bounded %s category",
    (category) => {
      expect(eligible(decision({ category }), config())).toBe(true)
    },
  )

  test("defers human decisions, stated risk, security-sensitive effects, and explicit ambiguity", () => {
    for (const value of [
      decision({ category: "defer" }),
      decision({ eligible: false }),
      decision({ requiresHumanDecision: true }),
      decision({ risks: ["A caller could receive a different result."] }),
      decision({ proposedFix: "Change authentication checks to accept the request." }),
      decision({ reason: "The expected behavior is unclear." }),
      decision({ proposedFix: "Correct the login response." }),
      decision({ affectedFiles: ["src/token.ts"] }),
      decision({ affectedFiles: ["src/identity/user.ts"] }),
      decision({ affectedFiles: ["README.md "] }),
    ])
      expect(eligible(value, config())).toBe(false)
    expect(
      eligible(decision({ affectedFiles: ["README.md", "docs/usage.md"] }), {
        ...config(),
        maxChangedFiles: 1,
      }),
    ).toBe(false)
    expect(eligible(decision({ affectedFiles: ["README.md", "readme.md"] }), config())).toBe(false)
  })

  test.each([
    "",
    "/etc/passwd",
    "../file",
    "src/../file",
    "src/./file",
    "src//file",
    "src/",
    "C:/file",
    "C:file",
    "src\\file",
    "src/file\0.md",
    "src/file\n.md",
    "src/file.",
    "src/file ",
    "src/\u202efile",
  ])("rejects unsafe path %j", (path) => {
    expect(safePath(path)).toBe(false)
    expect(allowedPath(path, { ...config(), allowedPaths: ["**"] })).toBe(false)
  })

  test.each([
    ".git/config",
    "src/.GiThUb/workflows/ci.yml",
    ".pi/settings.json",
    "docs/.agents/example.md",
    "src/.husky/pre-commit",
    "AGENTS.md",
    "docs/claude.local.MD",
    ".env",
    "src/.ENV.production",
    "credentials.json",
    "src/secretS.txt",
    "docs/example.PEM",
    "package.json",
    "src/Package-Lock.JSON",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lockb",
    "tsconfig.json",
    "biome.jsonc",
    "vitest.config.ts",
    "src/jest.config.js",
    "tool.config.ts",
    ".netrc",
    ".lintstagedrc",
    "pyproject.toml",
    "uv.lock",
    "Dockerfile",
    "docs/Dockerfile.worker",
    "Containerfile",
    "src/build.containerfile",
    "compose.yaml",
    "docker-compose.yml",
    "src/deployment/release.ts",
    "src/AUTH/check.ts",
    "src/infrastructure/main.ts",
    "src/identity/user.ts",
    "main.tf",
  ])("hard exclusions cannot be overridden for %s", (path) => {
    expect(allowedPath(path, { ...config(), allowedPaths: ["**"] })).toBe(false)
  })

  test("matches root globs, dot paths, configured denials, and case variants consistently", () => {
    expect(allowedPath("README.md", config())).toBe(true)
    expect(allowedPath("DOCS/guide.md", config())).toBe(true)
    expect(allowedPath("src/.hidden.ts", config())).toBe(true)
    expect(allowedPath("lib/module.ts", config())).toBe(false)
    expect(allowedPath("docs/private.md", { ...config(), forbiddenPaths: ["**/PRIVATE.md"] })).toBe(
      false,
    )
    expect(
      allowedPath("private.md", {
        ...config(),
        allowedPaths: ["**"],
        forbiddenPaths: ["**/PRIVATE.md"],
      }),
    ).toBe(false)
    expect(safePath("src/routes/[slug].ts")).toBe(true)
  })

  test("fingerprints all non-Reina comments by author ID, independent of projections and order", () => {
    const value = issue()
    const initial = fingerprint(value, 99)
    expect(
      fingerprint(
        {
          ...value,
          labels: ["bot:approved"],
          state: "closed",
          comments: [...value.comments].reverse(),
        },
        99,
      ),
    ).toBe(initial)
    expect(
      fingerprint(
        {
          ...value,
          comments: [value.comments[0], { ...value.comments[1], body: "A changed own comment" }],
        },
        99,
      ),
    ).toBe(initial)
    for (const changed of [
      { ...value, title: `${value.title}!` },
      { ...value, body: `${value.body}!` },
      {
        ...value,
        comments: [{ ...value.comments[0], body: "Edited evidence" }, value.comments[1]],
      },
      {
        ...value,
        comments: [...value.comments, { id: 13, authorId: 51, body: "New human comment" }],
      },
      { ...value, comments: [] },
    ])
      expect(fingerprint(changed, 99)).not.toBe(initial)
    expect(
      fingerprint(
        { ...value, comments: [{ id: 15, authorId: 98, body: "Another bot also counts" }] },
        99,
      ),
    ).not.toBe(initial)
  })

  test("canonical proposals bind baseline, scope, behavior, verification, dependencies, image, and policy for 24 hours", () => {
    const now = 1_800_000_000_000
    const value = makeProposal(
      issue(),
      snapshot(),
      decision({ affectedFiles: ["docs/usage.md", "README.md"] }),
      config(),
      99,
      now,
    )
    const reordered = makeProposal(
      issue(),
      snapshot(),
      decision({ affectedFiles: ["README.md", "docs/usage.md"] }),
      { ...config(), allowedPaths: [...config().allowedPaths].reverse() },
      99,
      now,
    )
    expect(value.revision).toBe(reordered.revision)
    expect(value.expiresAt - value.createdAt).toBe(86_400_000)
    expect(makeProposal(issue(), snapshot(), decision(), config(), 99, now + 999).createdAt).toBe(
      now,
    )
    expect(value.decision.affectedFiles).toEqual(["README.md", "docs/usage.md"])
    const baseline = makeProposal(issue(), snapshot(), decision(), config(), 99, now)
    const changedDependency = snapshot()
    changedDependency.files["package-lock.json"].content = Buffer.from("changed")
    const variations = [
      makeProposal(issue(), { ...snapshot(), sha: "b".repeat(40) }, decision(), config(), 99, now),
      makeProposal(issue(), { ...snapshot(), branch: "default" }, decision(), config(), 99, now),
      makeProposal(issue(), changedDependency, decision(), config(), 99, now),
      makeProposal(
        issue(),
        snapshot(),
        decision({ proposedFix: "Correct another example." }),
        config(),
        99,
        now,
      ),
      makeProposal(
        issue(),
        snapshot(),
        decision(),
        { ...config(), commands: [["npm", "test"]] },
        99,
        now,
      ),
      makeProposal(
        issue(),
        snapshot(),
        decision(),
        { ...config(), image: `sha256:${"b".repeat(64)}` },
        99,
        now,
      ),
      makeProposal(issue(), snapshot(), decision(), config(), 99, now + 1_000),
    ]
    for (const changed of variations) expect(changed.revision).not.toBe(baseline.revision)
    const originalHash = policyHash(config())
    expect(
      policyHash({ ...config(), modelKey: "rotated-credential", stateDir: "/private/elsewhere" }),
    ).toBe(originalHash)
    expect(policyHash({ ...config(), maxPatchBytes: 32_768 })).not.toBe(originalHash)
    expect(
      policyHash({ ...config(), forbiddenPaths: [...config().forbiddenPaths, "src/core/**"] }),
    ).not.toBe(originalHash)
  })

  test("host review cycles bind new proposals without changing legacy serialized fields", () => {
    const now = 1_800_000_000_000
    const firstCycle = "7505fea0-79f6-4163-a3ee-4213e4e934c8"
    const secondCycle = "0ec47f5f-f377-4669-87a5-18dd3e99cb47"
    const legacy = makeProposal(issue(), snapshot(), decision(), config(), 99, now)
    const first = makeProposal(issue(), snapshot(), decision(), config(), 99, now, firstCycle)
    const repeated = makeProposal(issue(), snapshot(), decision(), config(), 99, now, firstCycle)
    const second = makeProposal(issue(), snapshot(), decision(), config(), 99, now, secondCycle)
    expect(first).toEqual(repeated)
    expect(first.revision).not.toBe(second.revision)
    expect(first.revision).not.toBe(legacy.revision)
    const { revision: _first, ...firstFields } = first
    const { revision: _legacy, ...legacyFields } = legacy
    expect(firstFields).toEqual(legacyFields)
    expect(makeProposal(issue(), snapshot(), decision(), config(), 99, now, undefined)).toEqual(
      legacy,
    )
    expect(() =>
      makeProposal(issue(), snapshot(), decision(), config(), 99, now, "untrusted"),
    ).toThrow()
  })

  test("model API and revision changes invalidate policy and proposals, but key rotation does not", () => {
    const now = 1_800_000_000_000
    const original: Config = {
      ...config(),
      modelApi: "openai-completions",
      modelRevision: "fixture-revision-1",
    }
    const baseline = makeProposal(issue(), snapshot(), decision(), original, 99, now)
    for (const changed of [
      { ...original, modelApi: "openai-responses" as const },
      { ...original, modelRevision: "fixture-revision-2" },
      { ...original, modelApi: undefined },
      { ...original, modelRevision: undefined },
    ]) {
      expect(policyHash(changed)).not.toBe(policyHash(original))
      expect(makeProposal(issue(), snapshot(), decision(), changed, 99, now).revision).not.toBe(
        baseline.revision,
      )
    }
    const rotated = { ...original, modelKey: "rotated-fixture-key" }
    expect(policyHash(rotated)).toBe(policyHash(original))
    expect(makeProposal(issue(), snapshot(), decision(), rotated, 99, now)).toEqual(baseline)
  })

  test("rejects closed, foreign, excluded, PR, or oversized evidence rather than truncating", () => {
    const value = issue()
    for (const changed of [
      { ...value, state: "closed" as const },
      { ...value, pullRequest: true },
      { ...value, labels: ["bot:skip"] },
      { ...value, ref: { ...value.ref, id: 999 } },
      { ...value, ref: { ...value.ref, installationId: 999 } },
      { ...value, body: "x".repeat(131_073) },
      {
        ...value,
        comments: Array.from({ length: 101 }, (_, id) => ({ id, authorId: 2, body: "" })),
      },
    ])
      expect(() => makeProposal(changed, snapshot(), decision(), config(), 99)).toThrow()
  })
})

describe("durable store", () => {
  test("accepts the inbox durably before return, deduplicates completed events, and bounds retries", () => {
    let store = openStore()
    const payload = { kind: "issue", number: 1, nested: [true, null, "data"] }
    expect(store.acceptDelivery("delivery-1", payload).queued).toBe(true)
    payload.number = 2
    expect(store.acceptDelivery("delivery-1", { other: true }).queued).toBe(false)
    store.close()
    store = openStore()
    expect(store.deliveries()).toEqual([
      { id: "delivery-1", payload: { kind: "issue", number: 1, nested: [true, null, "data"] } },
    ])
    store.completeDelivery("delivery-1")
    expect(store.deliveries()).toEqual([])
    expect(store.acceptDelivery("delivery-1", {}).queued).toBe(false)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now())
    store.acceptDelivery("retry", {})
    store.deferDelivery("retry", 5_000)
    expect(store.deliveries()).toEqual([])
    vi.advanceTimersByTime(5_000)
    expect(store.deliveries().map((item) => item.id)).toEqual(["retry"])
    for (let attempt = 1; attempt < 8; attempt++) store.deferDelivery("retry", 0)
    expect(store.deliveries()).toEqual([])
    expect(store.acceptDelivery("retry", {}).queued).toBe(false)
  })

  test("issue-local retries retain the payload across restart without blocking other deliveries", () => {
    vi.useFakeTimers()
    const now = Date.now()
    vi.setSystemTime(now)
    let store = openStore()
    const payload = { kind: "approval", number: 1 }
    store.acceptDelivery("local", payload)
    store.deferDelivery("local", 5_000, "issue")
    store.acceptDelivery("unrelated", { number: 2 })
    expect(store.deliveries()).toEqual([{ id: "unrelated", payload: { number: 2 } }])
    expect(store.blockedUntil()).toBe(0)
    store.close()
    store = openStore()
    expect(store.deliveries()).toEqual([{ id: "unrelated", payload: { number: 2 } }])
    expect(store.blockedUntil()).toBe(0)
    store.completeDelivery("unrelated")
    vi.advanceTimersByTime(4_999)
    expect(store.deliveries()).toEqual([])
    vi.advanceTimersByTime(1)
    expect(store.deliveries()).toEqual([{ id: "local", payload }])
    store.completeDelivery("local")
    expect(store.acceptDelivery("local", payload).queued).toBe(false)
  })

  test("a direct inbox binding is immutable and survives deferral and restart", () => {
    let store = openStore()
    const value = proposal()
    const createdAt = value.createdAt
    const payload = {
      kind: "issue",
      ref: value.ref,
      request: {
        kind: "comment",
        commentId: 300,
        bodyHash: "c".repeat(64),
        createdAt,
        updatedAt: createdAt,
      },
    }
    const binding = {
      fingerprint: value.fingerprint,
      baseSha: value.baseSha,
      baseBranch: value.baseBranch,
      policyHash: value.policyHash,
    }
    store.acceptDelivery("bound-request", payload)
    store.bindRequest("bound-request", binding)
    store.bindRequest("bound-request", binding)
    for (const changed of [
      { ...binding, fingerprint: "d".repeat(64) },
      { ...binding, baseSha: "e".repeat(40) },
      { ...binding, baseBranch: "other" },
      { ...binding, policyHash: "f".repeat(64) },
    ])
      expect(() => store.bindRequest("bound-request", changed)).toThrow("proposal_stale")
    store.deferDelivery("bound-request", 0, "issue")
    store.close()
    store = openStore()
    expect(store.deliveries()).toEqual([
      { id: "bound-request", payload: { ...payload, requestBinding: binding } },
    ])
    store.completeDelivery("bound-request")
    expect(() => store.bindRequest("bound-request", binding)).toThrow("job_cancelled")
  })

  test("issue-local retries exhaust the eight-attempt limit durably", () => {
    vi.useFakeTimers()
    let store = openStore()
    store.acceptDelivery("local-exhausted", {})
    for (let attempt = 1; attempt <= 8; attempt++) {
      store.deferDelivery("local-exhausted", 1_000, "issue")
      expect(store.deliveries()).toEqual([])
      expect(store.blockedUntil()).toBe(0)
      vi.advanceTimersByTime(1_000)
      expect(store.deliveries()).toHaveLength(attempt < 8 ? 1 : 0)
    }
    store.close()
    store = openStore()
    expect(store.deliveries()).toEqual([])
    expect(store.acceptDelivery("local-exhausted", {}).queued).toBe(false)
    expect(store.blockedUntil()).toBe(0)
  })

  test("issue-local retries neither clear nor extend an earlier global cooldown", () => {
    vi.useFakeTimers()
    let store = openStore()
    store.acceptDelivery("mixed", {})
    store.deferDelivery("mixed", 5_000)
    const deadline = store.blockedUntil()
    expect(deadline).toBe(Date.now() + 5_000)
    store.deferDelivery("mixed", 1_000, "issue")
    expect(store.blockedUntil()).toBe(deadline)
    vi.advanceTimersByTime(1_000)
    expect(store.deliveries()).toEqual([{ id: "mixed", payload: {} }])
    store.deferDelivery("mixed", 10_000, "issue")
    expect(store.blockedUntil()).toBe(deadline)
    store.close()
    store = openStore()
    expect(store.blockedUntil()).toBe(deadline)
    expect(store.deliveries()).toEqual([])
    store.completeDelivery("mixed")
    expect(store.blockedUntil()).toBe(deadline)
  })

  test("rejects non-JSON, credentials, and oversized inbox input without accepting it", () => {
    const store = openStore()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    for (const payload of [
      undefined,
      Number.NaN,
      new Date(),
      circular,
      { authorization: "Bearer private" },
      { nested: { token: "private" } },
      "x".repeat(2_097_153),
    ]) {
      expect(() => store.acceptDelivery("invalid", payload)).toThrow()
      expect(store.deliveries()).toEqual([])
    }
    expect(store.acceptDelivery("invalid", {}).queued).toBe(true)
    expect(() => store.deferDelivery("invalid", -1)).toThrow()
  })

  test("persists only hashes of assessment keys and preserves them across restart", () => {
    let store = openStore()
    const assessment = "issueFingerprint:baseSha:policyHash:day"
    expect(store.assessed(assessment)).toBe(false)
    store.rememberAssessment(assessment)
    store.rememberAssessment(assessment)
    expect(store.assessed(assessment)).toBe(true)
    expect(store.assessed(`${assessment}-changed`)).toBe(false)
    store.close()
    store = openStore()
    expect(store.assessed(assessment)).toBe(true)
    store.close()
    expect(
      readFileSync(join(directory, "state", "reina.sqlite")).includes(Buffer.from(assessment)),
    ).toBe(false)
  })

  test.each([1, 2, 3])(
    "migrates version %s without losing inbox state or legacy global cooldowns",
    (version) => {
      vi.useFakeTimers()
      const now = Date.now()
      vi.setSystemTime(now)
      let store = openStore()
      store.acceptDelivery("before-migration", {})
      store.acceptDelivery("pending", {})
      store.deferDelivery("pending", 1_000)
      store.acceptDelivery("complete", {})
      store.deferDelivery("complete", 2_000)
      store.completeDelivery("complete")
      store.acceptDelivery("failed", {})
      for (let attempt = 0; attempt < 8; attempt++) store.deferDelivery("failed", 3_000)
      store.close()
      const path = join(directory, "state", "reina.sqlite")
      const db = new DatabaseSync(path)
      db.exec(`DROP TABLE reviews; DROP TABLE review_cursor;
        DROP TABLE request_epoch; DROP INDEX deliveries_by_request;
        ALTER TABLE deliveries DROP COLUMN request_key;
        ALTER TABLE deliveries DROP COLUMN global_until;
        ${version < 3 ? "DROP TABLE scan_cursor; DROP INDEX one_active_job_slot;" : ""}
        ${version === 1 ? "DROP TABLE assessments;" : ""}
        PRAGMA user_version = ${version};`)
      db.close()
      store = openStore()
      expect(store.deliveries()).toEqual([{ id: "before-migration", payload: {} }])
      expect(store.blockedUntil()).toBe(now + 3_000)
      expect(store.scanPage()).toBe(1)
      store.rememberAssessment("migrated")
      expect(store.assessed("migrated")).toBe(true)
      const migrated = new DatabaseSync(path, { readOnly: true })
      try {
        expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
        expect(
          migrated
            .prepare("SELECT id,global_until FROM deliveries ORDER BY id")
            .all()
            .map((row) => ({ ...row })),
        ).toEqual([
          { id: "before-migration", global_until: 0 },
          { id: "complete", global_until: now + 2_000 },
          { id: "failed", global_until: now + 3_000 },
          { id: "pending", global_until: now + 1_000 },
        ])
      } finally {
        migrated.close()
      }
      vi.advanceTimersByTime(3_000)
      expect(store.deliveries()).toEqual([
        { id: "before-migration", payload: {} },
        { id: "pending", payload: {} },
      ])
      store.close()
      expect(openStore().blockedUntil()).toBe(now + 3_000)
    },
  )

  test("migrates schema 4 without inventing reviews or changing proposal and job authority", () => {
    let store = openStore()
    const value = proposal()
    store.saveProposal(value)
    const authority = approval(value)
    const job = publishing(store, required(store.claim(value, authority)))
    store.rememberAssessment("legacy-attempt-not-a-completed-review")
    store.acceptDelivery("legacy-delivery", { kind: "issue", ref: value.ref })
    store.saveScanPage(17)
    store.close()
    const path = join(directory, "state", "reina.sqlite")
    const db = new DatabaseSync(path)
    db.exec(`DROP TABLE reviews; DROP TABLE review_cursor;
      DROP TABLE request_epoch; DROP INDEX deliveries_by_request;
      ALTER TABLE deliveries DROP COLUMN request_key; PRAGMA user_version = 4;`)
    db.close()

    store = openStore()
    expect(store.proposal(value.ref)).toEqual(value)
    expect(store.job(job.id)).toEqual(job)
    expect(store.claim(value, authority)).toBeUndefined()
    expect(store.assessed("legacy-attempt-not-a-completed-review")).toBe(true)
    expect(store.review(value.ref)).toBeUndefined()
    expect(store.reviewBatch(10)).toEqual([])
    expect(store.scanPage()).toBe(17)
    expect(store.deliveries()).toEqual([
      { id: "legacy-delivery", payload: { kind: "issue", ref: value.ref } },
    ])
    const migrated = new DatabaseSync(path, { readOnly: true })
    try {
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(6)
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM reviews").get()?.count).toBe(0)
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM review_cursor").get()?.count).toBe(1)
    } finally {
      migrated.close()
    }
  })

  test("persists the bounded single-repository scan cursor", () => {
    let store = openStore()
    expect(store.scanPage()).toBe(1)
    store.saveScanPage(17)
    store.close()
    store = openStore()
    expect(store.scanPage()).toBe(17)
    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => store.saveScanPage(value)).toThrow()
    expect(store.scanPage()).toBe(17)
  })

  test("requires stored, published, fresh human authority; rejected attempts do not consume it", () => {
    const store = openStore()
    const value = proposal()
    const authority = approval(value)
    expect(store.claim(value, authority)).toBeUndefined()
    const {
      commentIntent: _intent,
      commentId: _comment,
      publishedAt: _published,
      ...unpublished
    } = value
    store.saveProposal(unpublished)
    expect(store.claim(unpublished, authority)).toBeUndefined()
    store.saveProposal(value)
    for (const invalid of [
      { ...authority, actor: { ...authority.actor, type: "Bot" } },
      { ...authority, permission: "read" },
      { ...authority, proposalRevision: "b".repeat(64) },
      { ...authority, createdAt: required(value.publishedAt) },
      { ...authority, createdAt: Date.now() + 100_000 },
    ])
      expect(store.claim(value, invalid)).toBeUndefined()
    expect(store.claim({ ...value, commands: [["npm", "test"]] }, authority)).toBeUndefined()
    expect(store.claim(value, authority)).toBeDefined()
  })

  test.each(["comment", "assignment"] as const)(
    "%s requests can precede publication but each source is consumed once across restart",
    (kind) => {
      let store = openStore()
      const value = proposal()
      const createdAt = value.createdAt - 1_000
      const authority = directApproval(value, kind)
      store.saveProposal(value)
      expect(store.claim(value, authority)).toBeUndefined()
      expect(store.claim(value, authority, "missing-source")).toBeUndefined()
      const completedAuthority = directApproval(value, kind, 301, createdAt - 1)
      const completed = acceptRequest(store, value, completedAuthority, "completed-source")
      store.completeDelivery(completed)
      expect(store.claim(value, completedAuthority, completed)).toBeUndefined()
      const wrongSource = acceptRequest(
        store,
        value,
        directApproval(value, kind, 302, createdAt - 2),
        "mismatched-source",
      )
      expect(store.claim(value, authority, wrongSource)).toBeUndefined()
      store.completeDelivery(wrongSource)
      for (const [index, changed] of [
        { ...value, fingerprint: "d".repeat(64) },
        { ...value, baseSha: "e".repeat(40) },
        { ...value, baseBranch: "other" },
        { ...value, policyHash: "f".repeat(64) },
      ].entries()) {
        const bindingAuthority = directApproval(value, kind, 303 + index, createdAt - 3 - index)
        const wrongBinding = acceptRequest(
          store,
          changed,
          bindingAuthority,
          `mismatched-binding-${index}`,
        )
        expect(store.deliveries()).toContainEqual({
          id: wrongBinding,
          payload: expect.objectContaining({ requestBinding: expect.any(Object) }),
        })
        expect(store.claim(value, bindingAuthority, wrongBinding)).toBeUndefined()
        store.completeDelivery(wrongBinding)
      }
      const source = acceptRequest(store, value, authority)
      const { request: _request, ...labelAuthority } = authority
      expect(store.claim(value, labelAuthority, source)).toBeUndefined()
      for (const invalid of [
        { ...authority, eventId: "unbound-source" },
        { ...authority, createdAt: createdAt + 1 },
        { ...authority, permission: "read" },
        { ...authority, actor: { ...authority.actor, type: "Bot" } },
        { ...authority, actor: { id: 51, login: "outsider", type: "User" } },
      ])
        expect(store.claim(value, invalid, source)).toBeUndefined()
      const job = required(store.claim(value, authority, source))
      expect(job.approval).toEqual(authority)
      expect(job.approval.createdAt).toBeLessThan(required(value.publishedAt))
      advance(store, job, "failed", { error: "fixture_failure" })
      store.close()
      store = openStore()
      expect(store.job(job.id)?.approval).toEqual(authority)
      expect(store.claim(value, authority, source)).toBeUndefined()
      const replacement = proposal(1, value.createdAt + 1_000)
      store.saveProposal(replacement)
      expect(
        store.claim(replacement, { ...authority, proposalRevision: replacement.revision }, source),
      ).toBeUndefined()
      expect(store.jobs()).toHaveLength(1)
    },
  )

  test("a direct request does not relax publication, expiry, or source-time checks", () => {
    const store = openStore()
    const value = proposal()
    const createdAt = value.createdAt - 1_000
    const authority: Approval = {
      ...approval(value),
      eventId: "comment:300",
      createdAt,
      request: {
        kind: "comment",
        commentId: 300,
        bodyHash: "c".repeat(64),
        createdAt,
        updatedAt: createdAt,
      },
    }
    const {
      commentId: _id,
      publishedAt: _published,
      commentIntent: _intent,
      ...unpublished
    } = value
    const source = acceptRequest(store, value, authority)
    store.saveProposal(unpublished)
    expect(store.claim(unpublished, authority, source)).toBeUndefined()
    store.saveProposal(value)
    for (const [index, time] of [Date.now() + 1_000, Date.now() - 86_400_000].entries()) {
      const invalid = directApproval(value, "comment", 301 + index, time)
      const invalidSource = acceptRequest(store, value, invalid, `invalid-source-${time}`)
      expect(store.claim(value, invalid, invalidSource)).toBeUndefined()
    }
    expect(store.claim(value, authority, source)).toBeDefined()
  })

  test("atomically consumes each approval once and permits only one active job per issue", async () => {
    const store = openStore()
    const value = proposal()
    store.saveProposal(value)
    const authority = approval(value)
    const results = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => store.claim(value, authority))),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(store.claim(value, approval(value, "other-approval"))).toBeUndefined()
    const job = required(results.find(Boolean))
    advance(store, job, "failed", { error: "fixture_failure" })
    expect(store.claim(value, authority)).toBeUndefined()
    expect(store.claim(value, approval(value, "other-approval"))).toBeDefined()
  })

  test("reserves a single global active slot without consuming blocked approvals", () => {
    const store = openStore()
    const first = claim(store, 1)
    const second = proposal(2)
    const authority = approval(second, "approval-2")
    store.saveProposal(second)
    expect(store.claim(second, authority)).toBeUndefined()
    advance(store, first, "failed", { error: "fixture_failure" })
    expect(store.claim(second, authority)).toBeDefined()
  })

  test("refuses expired and superseded proposals and cannot restore invalidated authority", () => {
    const store = openStore()
    const expired = proposal(1, Date.now() - 86_400_001)
    store.saveProposal(expired)
    expect(store.claim(expired, approval(expired))).toBeUndefined()
    const current = proposal()
    store.saveProposal(current)
    expect(store.claim(expired, approval(expired))).toBeUndefined()
    const job = required(store.claim(current, approval(current)))
    store.invalidate(current.ref)
    expect(store.proposal(current.ref)).toBeUndefined()
    expect(store.job(job.id)?.state).toBe("cancelled")
    expect(() => store.saveProposal(current)).toThrow(/immutable/)
    expect(store.claim(current, approval(current, "new-transition"))).toBeUndefined()
  })

  test("guards lifecycle, authority, immutable artifacts, and monotonic publication records", () => {
    const store = openStore()
    const job = claim(store)
    expect(() => store.saveJob({ ...job, id: "invented" })).toThrow(/approval claim/)
    expect(() => advance(store, job, "publishing", { artifact: artifact() })).toThrow(/transition/)
    expect(() =>
      store.saveJob({ ...job, approval: { ...job.approval, eventId: "replaced" } }),
    ).toThrow(/immutable/)
    let current = publishing(store, job)
    expect(() =>
      store.saveJob({ ...current, artifact: { ...required(current.artifact), diff: "changed" } }),
    ).toThrow(/immutable/)
    current = advance(store, current, "publishing", {
      publication: { branch: "narumi/fix/reina-issue-1", commitSha: "f".repeat(40) },
    })
    expect(() => store.saveJob({ ...current, publication: { branch: "other" } })).toThrow(
      /immutable/,
    )
    current = advance(store, current, "publishing", {
      publication: { ...required(current.publication), prIntent: true },
    })
    expect(() =>
      store.saveJob({
        ...current,
        publication: { ...required(current.publication), prIntent: false },
      }),
    ).toThrow(/immutable/)
    current = advance(store, current, "pr_ready", {
      publication: {
        ...required(current.publication),
        prNumber: 20,
        prUrl: "https://github.com/example/project/pull/20",
      },
    })
    expect(() => advance(store, current, "working")).toThrow(/transition/)
    expect(store.job(job.id)?.artifact).toEqual(artifact())
  })

  test("persists comment intent but never changes bound proposal content or publication identity", () => {
    const store = openStore()
    const { commentIntent: _intent, commentId: _id, publishedAt: _published, ...value } = proposal()
    store.saveProposal(value)
    store.saveProposal({ ...value, commentIntent: true })
    expect(store.proposal(value.ref)?.commentIntent).toBe(true)
    expect(() => store.saveProposal(value)).toThrow(/immutable/)
    expect(() =>
      store.saveProposal({
        ...value,
        commentIntent: true,
        decision: decision({ proposedFix: "Another change" }),
      }),
    ).toThrow(/immutable/)
  })

  test("retry authorizations survive SQLite reopen and consumption without clearing intent", () => {
    let store = openStore()
    const { commentId: _id, publishedAt: _published, ...pending } = proposal(2)
    const retryAt = Date.now() + 1000
    store.saveProposal(pending)
    store.saveProposal({ ...pending, commentRetryAt: retryAt })
    let job = publishing(store, claim(store))
    job = advance(store, job, "publishing", {
      publication: {
        branch: "narumi/fix/reina-issue-1",
        commitSha: "f".repeat(40),
        prIntent: true,
        prRetryAt: retryAt,
      },
    })
    store.close()
    store = openStore()
    expect(store.proposal(pending.ref)?.commentRetryAt).toBe(retryAt)
    expect(store.job(job.id)?.publication?.prRetryAt).toBe(retryAt)
    const { commentRetryAt: _commentRetry, ...consumed } = required(store.proposal(pending.ref))
    store.saveProposal(consumed)
    const { prRetryAt: _prRetry, ...publication } = required(
      required(store.job(job.id)).publication,
    )
    store.saveJob({ ...job, publication })
    store.close()
    store = openStore()
    expect(store.proposal(pending.ref)).toMatchObject({ commentIntent: true })
    expect(store.proposal(pending.ref)?.commentRetryAt).toBeUndefined()
    expect(store.job(job.id)?.publication).toMatchObject({ prIntent: true })
    expect(store.job(job.id)?.publication?.prRetryAt).toBeUndefined()
    expect(() => store.saveProposal({ ...consumed, commentIntent: false })).toThrow(/immutable/)
    expect(() =>
      store.saveJob({ ...job, publication: { ...publication, prIntent: false } }),
    ).toThrow(/immutable/)
  })

  test("retry state requires intent, valid timestamps, and no confirmed identity", () => {
    const store = openStore()
    const {
      commentIntent: _intent,
      commentId: _id,
      publishedAt: _published,
      ...pending
    } = proposal(2)
    const retryAt = Date.now() + 1000
    for (const fields of [
      { commentRetryAt: retryAt },
      { commentIntent: true, commentRetryAt: -1 },
      { commentIntent: true, commentRetryAt: 1.5 },
      { commentIntent: true, commentRetryAt: retryAt, commentId: 20 },
    ])
      expect(() => store.saveProposal({ ...pending, ...fields })).toThrow()
    const confirmed = proposal(2)
    store.saveProposal(confirmed)
    expect(() => store.saveProposal({ ...confirmed, commentId: 999 })).toThrow(/immutable/)
    let job = publishing(store, claim(store))
    const publication = { branch: "narumi/fix/reina-issue-1", commitSha: "f".repeat(40) }
    for (const fields of [
      { prRetryAt: retryAt },
      { prIntent: true, prRetryAt: -1 },
      { prIntent: true, prRetryAt: retryAt, prNumber: 20 },
      { prIntent: true, prRetryAt: retryAt, prUrl: "https://github.com/example/project/pull/20" },
    ])
      expect(() => store.saveJob({ ...job, publication: { ...publication, ...fields } })).toThrow()
    job = advance(store, job, "pr_ready", {
      publication: {
        ...publication,
        prIntent: true,
        prNumber: 20,
        prUrl: "https://github.com/example/project/pull/20",
      },
    })
    expect(() =>
      store.saveJob({ ...job, publication: { ...required(job.publication), prNumber: 21 } }),
    ).toThrow(/immutable/)
    expect(() =>
      store.saveJob({
        ...job,
        publication: {
          ...required(job.publication),
          prUrl: "https://github.com/example/project/pull/21",
        },
      }),
    ).toThrow(/immutable/)
  })

  test("terminal PR history blocks new approvals, including a PR recorded after cancellation", () => {
    const store = openStore()
    let job = publishing(store, claim(store))
    job = advance(store, job, "pr_ready", {
      publication: {
        branch: "narumi/fix/reina-issue-1",
        commitSha: "f".repeat(40),
        prIntent: true,
        prNumber: 20,
        prUrl: "https://github.com/example/project/pull/20",
      },
    })
    const next = proposal(1, Date.now() - 5_000)
    store.saveProposal(next)
    expect(store.claim(next, approval(next, "new-approval"))).toBeUndefined()
    expect(store.job(job.id)?.state).toBe("pr_ready")
    const other = publishing(store, claim(store, 2))
    store.cancel(other.ref)
    store.saveJob({
      ...required(store.job(other.id)),
      publication: { branch: "narumi/fix/reina-issue-2", prNumber: 21 },
    })
    const otherNext = proposal(2, Date.now() - 5_000)
    store.saveProposal(otherNext)
    expect(store.claim(otherNext, approval(otherNext, "new-approval-2"))).toBeUndefined()
  })

  test.each(["approved", "working", "validating", "publishing"] as const)(
    "restart safely recovers %s without replay",
    (state) => {
      let store = openStore()
      let job = claim(store)
      if (state !== "approved") job = advance(store, job, "working")
      if (state === "validating" || state === "publishing") job = advance(store, job, "validating")
      if (state === "publishing") job = advance(store, job, "publishing", { artifact: artifact() })
      store.close()
      store = openStore()
      if (state === "publishing") {
        expect(store.job(job.id)).toEqual(job)
        expect(store.proposal(job.ref)).toBeDefined()
        store.cancel(job.ref)
        expect(store.job(job.id)?.artifact).toEqual(job.artifact)
      } else {
        expect(store.job(job.id)).toMatchObject({ state: "failed", error: "interrupted" })
        expect(store.claim(required(store.proposal(job.ref)), job.approval)).toBeUndefined()
      }
    },
  )

  test("allows terminal notification only once and persists the acknowledgement", () => {
    let store = openStore()
    let job = claim(store)
    expect(() => store.saveJob({ ...job, notified: true })).toThrow(/Invalid job/)
    job = advance(store, job, "failed", { notified: true, error: "fixture_failure" })
    expect(() => store.saveJob({ ...job, notified: false })).toThrow(/immutable/)
    store.close()
    store = openStore()
    expect(store.job(job.id)?.notified).toBe(true)
  })

  test("validates persisted records and fails closed on corruption", () => {
    const store = openStore()
    const job = claim(store)
    const db = new DatabaseSync(join(directory, "state", "reina.sqlite"))
    db.prepare("UPDATE jobs SET json = ? WHERE id = ?").run('{"state":"approved"}', job.id)
    db.close()
    expect(() => store.job(job.id)).toThrow(/Invalid persisted job/)
    store.close()
    expect(() => openStore()).toThrow(/Invalid persisted job/)
  })

  test("keeps private permissions, rejects duplicate instances, and fails safely after close", () => {
    const store = openStore()
    expect(statSync(join(directory, "state")).mode & 0o777).toBe(0o700)
    expect(statSync(join(directory, "state", "reina.sqlite")).mode & 0o777).toBe(0o600)
    expect(() => new Store(join(directory, "state"))).toThrow(/locked/)
    store.close()
    store.close()
    for (const operation of [
      () => store.acceptDelivery("after-close", {}),
      () => store.deliveries(),
      () => store.completeDelivery("x"),
      () => store.deferDelivery("x", 0),
      () => store.jobs(),
      () => store.job("x"),
      () => store.saveProposal(proposal()),
      () => store.proposal(issue().ref),
      () => store.invalidate(issue().ref),
      () => store.cancel(issue().ref),
      () => store.claim(proposal(), approval(proposal())),
      () => store.assessed("x"),
      () => store.rememberAssessment("x"),
      () => store.scanPage(),
      () => store.saveScanPage(2),
      () => store.review(issue().ref),
      () => store.reviewBatch(10),
    ])
      expect(operation).toThrow(/closed/)
    expect(() => openStore()).not.toThrow()
  })

  test("real process lock survives data commits and is released by the OS after SIGKILL", async () => {
    const childPath = fileURLToPath(new URL("./core-lock-child.ts", import.meta.url))
    const start = () => {
      const child = spawn(process.execPath, [childPath, resolve(directory, "state")], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
      children.push(child)
      return {
        child,
        status: new Promise<unknown>((resolve, reject) => {
          child.once("message", resolve)
          child.once("error", reject)
          child.once("exit", (code) => {
            if (code !== 0 && code !== 2) reject(new Error(`Lock child exited: ${code}`))
          })
        }),
      }
    }
    const holder = start()
    expect(await holder.status).toBe("ready")
    const contender = start()
    expect(await contender.status).toBe("locked")
    expect(() => openStore()).toThrow(/locked/)
    const exited = new Promise<void>((resolve) => holder.child.once("exit", () => resolve()))
    holder.child.kill("SIGKILL")
    await exited
    const store = openStore()
    expect(store.acceptDelivery("lock-probe", {}).queued).toBe(false)
    expect(store.acceptDelivery("after-crash", { kind: "scan" }).queued).toBe(true)
    store.close()
    const reopened = openStore()
    expect(reopened.deliveries()).toHaveLength(1)
  }, 20_000)
})
