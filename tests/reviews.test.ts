import { randomUUID } from "node:crypto"
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Store } from "../src/jobs/store.js"
import type { Assessment } from "../src/triage/assessment.js"
import {
  REVIEW_LABELS,
  REVIEW_RESULT_LIMIT,
  type Review,
  reviewSchema,
} from "../src/triage/review.js"
import type { Approval, Proposal } from "../src/types.js"

let directory: string
const stores: Store[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  directory = mkdtempSync(join(tmpdir(), "reina-reviews-"))
})
afterEach(() => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) store.close()
  rmSync(directory, { recursive: true, force: true })
})

function openStore(): Store {
  const store = new Store(directory)
  stores.push(store)
  return store
}
function inspect<T>(operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(directory, "reina.sqlite"))
  try {
    return operation(db)
  } finally {
    db.close()
  }
}
function assessment(): Assessment {
  return {
    kind: "documentation",
    summary: "The usage example has an incorrect command.",
    missingInfo: [],
    fix: {
      eligible: true,
      category: "documentation",
      reason: "The example uses an incorrect command name.",
      proposedFix: "Correct the command name.",
      affectedFiles: ["README.md"],
      verificationPlan: ["Inspect the example."],
      requiresHumanDecision: false,
      risks: [],
    },
  }
}
function review(number = 1): Review {
  return {
    ref: {
      owner: "example",
      name: "project",
      id: 456,
      installationId: 789,
      number,
      issueId: 1_000 + number,
    },
    revision: randomUUID(),
    binding: {
      fingerprint: "a".repeat(64),
      baseBranch: "main",
      baseSha: "b".repeat(40),
      policyHash: "c".repeat(64),
      protocolRevision: "reina-issue-triage-1",
    },
    state: "pending",
    attempts: 0,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
    nextAttemptAt: 0,
  }
}
function assessed(value = review()): Review {
  return {
    ...value,
    state: "assessed",
    attempts: 1,
    assessment: assessment(),
    outcome: "fix_candidate",
    assessedAt: value.updatedAt,
  }
}
function complete(value = assessed()): Review {
  return {
    ...value,
    state: "complete",
    commentIntent: true,
    commentId: 101,
    publishedRevision: value.revision,
  }
}
function nearLimitReview(): Review {
  const value = complete()
  if (!value.assessment) throw new Error("missing fixture assessment")
  value.assessment.summary = "Summary"
  value.assessment.fix = {
    ...value.assessment.fix,
    eligible: false,
    category: "defer",
    requiresHumanDecision: true,
    reason: "界".repeat(2_000),
    proposedFix: "界".repeat(4_000),
    affectedFiles: Array.from({ length: 10 }, (_, index) => `${index}${"界".repeat(500)}`),
    verificationPlan: Array(10).fill("界".repeat(1_000)),
  }
  value.outcome = "needs_human"
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(REVIEW_RESULT_LIMIT)
  expect(reviewSchema.safeParse(value).success).toBe(true)
  return value
}

function legacyRecords(store: Store, activeJob = false): void {
  const now = Date.now() - 10_000
  const value: Proposal = {
    revision: "d".repeat(64),
    ref: review().ref,
    fingerprint: "a".repeat(64),
    baseBranch: "main",
    baseSha: "b".repeat(40),
    decision: assessment().fix,
    commands: [["npm", "test"]],
    policyHash: "c".repeat(64),
    image: "fixture-image",
    createdAt: now,
    expiresAt: now + 86_400_000,
    commentIntent: true,
    commentId: 101,
    publishedAt: now + 1_000,
  }
  const authority: Approval = {
    eventId: "approval-fixture",
    actor: { id: 10, login: "maintainer", type: "User" },
    proposalRevision: value.revision,
    createdAt: now + 2_000,
    permission: "write",
  }
  store.saveProposal(value)
  const job = store.claim(value, authority)
  if (!job) throw new Error("Fixture claim failed")
  if (!activeJob) store.saveJob({ ...job, state: "failed", error: "fixture_failure" })
  store.rememberAssessment("legacy-attempt-not-success")
  store.acceptDelivery("fixture-delivery", { number: 1 })
  store.deferDelivery("fixture-delivery", 1_000, "issue")
  store.saveScanPage(17)
}
function downgrade(version: number): void {
  inspect((db) => {
    db.exec(`DROP TABLE reviews; DROP TABLE review_cursor;
      ${version < 4 ? "ALTER TABLE deliveries DROP COLUMN global_until;" : ""}
      ${version < 3 ? "DROP TABLE scan_cursor; DROP INDEX one_active_job_slot;" : ""}
      ${version === 1 ? "DROP TABLE assessments;" : ""}
      PRAGMA user_version = ${version};`)
  })
}

const preservedTables = ["proposals", "proposal_heads", "approvals", "jobs"] as const
function preservedRows(): unknown {
  return inspect((db) =>
    Object.fromEntries(
      preservedTables.map((name) => [
        name,
        db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
      ]),
    ),
  )
}

describe("strict review contract", () => {
  test("defines only the four controlled review labels", () => {
    expect(REVIEW_LABELS).toEqual([
      "bot:triaged",
      "bot:needs-info",
      "bot:needs-human",
      "bot:triage-failed",
    ])
    for (const value of [
      review(),
      assessed(),
      complete(),
      { ...review(), state: "running", attempts: 1 },
      { ...review(), state: "failed", error: "triage_unavailable" },
      { ...review(), state: "failed", publishedRevision: randomUUID() },
      { ...review(), state: "stale", publishedRevision: randomUUID() },
      { ...complete(), state: "stale", inactiveReason: "closed" },
    ])
      expect(reviewSchema.safeParse(value).success).toBe(true)
  })

  test("requires state-specific evidence and confirmed publication", () => {
    const pending = review()
    const result = assessed(pending)
    for (const value of [
      { ...pending, attempts: -1 },
      { ...pending, attempts: 4 },
      { ...pending, attempts: 1.5 },
      { ...pending, attempts: 3 },
      { ...pending, state: "running" },
      { ...pending, state: "assessed", attempts: 1 },
      { ...result, outcome: undefined },
      { ...result, assessment: undefined },
      { ...result, assessedAt: undefined },
      { ...result, attempts: 0 },
      { ...result, state: "pending" },
      { ...result, state: "failed" },
      { ...result, state: "complete", commentId: 1 },
      { ...complete(result), publishedRevision: randomUUID() },
      { ...complete(result), commentId: undefined },
      { ...result, error: "triage_failed" },
      { ...pending, assessedAt: 1 },
      { ...pending, inactiveReason: "closed" },
      { ...pending, commentRetryAt: 1 },
      { ...pending, updatedAt: pending.createdAt - 1 },
      { ...result, assessedAt: result.updatedAt + 1 },
    ])
      expect(reviewSchema.safeParse(value).success).toBe(false)
  })

  test("rejects unbounded identities, raw input, credentials, and unsafe errors", () => {
    const value = review()
    for (const changed of [
      { ...value, token: "fixture-private-token" },
      { ...value, request: { prompt: "fixture-private-prompt" } },
      { ...value, rawStream: "fixture-private-stream" },
      { ...value, snapshot: {} },
      { ...value, revision: "not-a-uuid" },
      { ...value, ref: { ...value.ref, installationId: 0 } },
      { ...value, ref: { ...value.ref, issueId: Number.MAX_SAFE_INTEGER + 1 } },
      { ...value, ref: { ...value.ref, owner: "x".repeat(40) } },
      { ...value, binding: { ...value.binding, token: "fixture-private-token" } },
      { ...value, binding: { ...value.binding, fingerprint: "a".repeat(63) } },
      { ...value, binding: { ...value.binding, baseSha: "not-a-sha" } },
      { ...value, binding: { ...value.binding, protocolRevision: "x".repeat(101) } },
      { ...value, binding: { ...value.binding, baseBranch: "main\nsecret" } },
      { ...value, error: "Bearer fixture-private-token" },
      { ...value, error: "triage_failure\n" },
      { ...value, error: "x".repeat(65) },
      { ...assessed(value), assessment: { ...assessment(), request: "private" } },
      { ...assessed(value), assessment: { ...assessment(), summary: "x".repeat(1_001) } },
    ])
      expect(reviewSchema.safeParse(changed).success).toBe(false)
  })

  test("bounds the whole JSON record in bytes, not only individual fields", () => {
    const value = assessed()
    value.assessment = {
      kind: "unknown",
      summary: "界".repeat(1_000),
      missingInfo: Array(5).fill("界".repeat(300)),
      fix: {
        eligible: false,
        category: "defer",
        reason: "界".repeat(2_000),
        proposedFix: "界".repeat(4_000),
        affectedFiles: Array.from({ length: 10 }, (_, index) => `${index}${"界".repeat(500)}`),
        verificationPlan: Array(10).fill("界".repeat(1_000)),
        requiresHumanDecision: true,
        risks: Array(10).fill("界".repeat(1_000)),
      },
    }
    value.outcome = "needs_human"
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(65_536)
    expect(reviewSchema.safeParse(value).success).toBe(false)
    expect(() => openStore().saveReview(value)).toThrow("Invalid review record")
    const whitespace = assessed()
    whitespace.assessment = { ...assessment(), summary: `${" ".repeat(65_536)}Summary` }
    expect(reviewSchema.safeParse(whitespace).success).toBe(false)
    const circular = { ...review(), raw: {} }
    circular.raw = circular
    expect(reviewSchema.safeParse(circular).success).toBe(false)
  })
})

describe("durable review storage", () => {
  test("fresh schema5 does not infer success from old attempt hashes", () => {
    const store = openStore()
    store.rememberAssessment("legacy-attempt-not-success")
    expect(store.review(review().ref)).toBeUndefined()
    expect(store.reviewBatch(100)).toEqual([])
    expect(inspect((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(5)
    expect(store.saveReview(review(), randomUUID())).toBe(false)
    expect(inspect((db) => db.prepare("SELECT COUNT(*) AS count FROM reviews").get()?.count)).toBe(
      0,
    )
  })

  test("CAS prevents in-flight stale work from restoring an invalidated revision", () => {
    const store = openStore()
    const initial = { ...review(), state: "running" as const, attempts: 1 }
    expect(store.saveReview(initial)).toBe(true)
    expect(store.saveReview(initial)).toBe(false)
    const current: Review = {
      ...initial,
      revision: randomUUID(),
      state: "stale",
      attempts: 0,
      inactiveReason: "changed",
      commentId: 101,
      commentIntent: true,
    }
    expect(store.saveReview(current, initial.revision)).toBe(true)
    expect(store.saveReview(complete(assessed(initial)), initial.revision)).toBe(false)
    expect(store.saveReview(initial, randomUUID())).toBe(false)
    expect(store.review(initial.ref)).toEqual(current)
    expect(
      inspect((db) => db.prepare("SELECT issue_key,revision,state,json FROM reviews").all()),
    ).toEqual([
      {
        issue_key: "456:1001",
        revision: current.revision,
        state: "stale",
        json: JSON.stringify(current),
      },
    ])
  })

  test("supports repeated successful cycles without resetting an exhausted cycle", () => {
    const store = openStore()
    let current = review()
    expect(store.saveReview(current)).toBe(true)
    for (let cycle = 0; cycle < 5; cycle++) {
      const success = complete(assessed(current))
      expect(store.saveReview(success, current.revision)).toBe(true)
      const next = {
        ...review(),
        createdAt: current.createdAt + 1,
        updatedAt: current.updatedAt + 1,
        commentId: success.commentId,
        commentIntent: true,
      }
      expect(store.saveReview(next, current.revision)).toBe(true)
      expect(store.saveReview(success, current.revision)).toBe(false)
      current = next
    }
    for (let attempts = 1; attempts <= 3; attempts++) {
      current = { ...current, state: "running", attempts }
      expect(store.saveReview(current, current.revision)).toBe(true)
      current = {
        ...current,
        state: attempts < 3 ? "pending" : "failed",
        error: "triage_transport",
        nextAttemptAt: current.updatedAt + 60_000,
      }
      expect(store.saveReview(current, current.revision)).toBe(true)
    }
    expect(() =>
      store.saveReview({ ...current, state: "pending", attempts: 0 }, current.revision),
    ).toThrow("Invalid review cycle update")
    expect(store.review(current.ref)).toEqual(current)
    store.close()
    expect(openStore().review(current.ref)).toEqual(current)
    expect(inspect((db) => db.prepare("SELECT revision,state,json FROM reviews").all())).toEqual([
      {
        revision: current.revision,
        state: "failed",
        json: JSON.stringify(reviewSchema.parse(current)),
      },
    ])
  })

  test("rejects same-revision binding, identity, creation-time and attempt rollback", () => {
    const store = openStore()
    const current = { ...review(), attempts: 1 }
    store.saveReview(current)
    for (const value of [
      { ...current, binding: { ...current.binding, policyHash: "d".repeat(64) } },
      { ...current, ref: { ...current.ref, installationId: 999 } },
      { ...current, revision: randomUUID(), ref: { ...current.ref, installationId: 999 } },
      { ...current, revision: randomUUID(), ref: { ...current.ref, owner: "other-owner" } },
      { ...current, createdAt: current.createdAt - 1 },
      { ...current, attempts: 0 },
      { ...current, updatedAt: current.updatedAt - 1, createdAt: current.createdAt - 1 },
    ])
      expect(() => store.saveReview(value, current.revision)).toThrow()
    expect(store.review(current.ref)).toEqual(current)
  })

  test.each(["complete", "running"])(
    "durable intake atomically revokes %s reviews and proposal authority before restart",
    (state) => {
      let store = openStore()
      legacyRecords(store)
      const original: Review =
        state === "complete"
          ? complete()
          : {
              ...review(),
              state: "running",
              attempts: 2,
              commentId: 101,
              commentIntent: true,
            }
      store.saveReview(original)
      expect(
        store.acceptDelivery(
          "atomic-revocation",
          { kind: "issue", ref: original.ref },
          [original.ref],
          [{ ref: original.ref, reason: "changed" }],
        ),
      ).toBe(true)
      const invalidated = store.review(original.ref)
      expect(invalidated).toMatchObject({
        state: "stale",
        attempts: original.attempts,
        commentId: 101,
      })
      expect(invalidated?.revision).not.toBe(original.revision)
      expect(invalidated?.publishedRevision).toBeUndefined()
      if (state === "running") expect(invalidated?.nextAttemptAt).toBe(Date.now() + 300_000)
      expect(store.proposal(original.ref)).toBeUndefined()
      store.close()
      store = openStore()
      expect(store.review(original.ref)).toEqual(invalidated)
      expect(store.proposal(original.ref)).toBeUndefined()
      expect(
        store.acceptDelivery(
          "atomic-revocation",
          {},
          [original.ref],
          [{ ref: original.ref, reason: "changed" }],
        ),
      ).toBe(false)
      expect(store.review(original.ref)).toEqual(invalidated)
    },
  )

  test("atomic revocation compacts restored near-limit results before adding lifecycle metadata", () => {
    const store = openStore()
    legacyRecords(store)
    const value = nearLimitReview()
    store.saveReview(value)
    expect(
      store.acceptDelivery(
        "compact-revocation",
        {},
        [value.ref],
        [{ ref: value.ref, reason: "changed" }],
      ),
    ).toBe(true)
    const revoked = store.review(value.ref)
    expect(revoked).toMatchObject({
      state: "stale",
      error: "triage_invalid_output",
      commentId: 101,
    })
    expect(revoked?.assessment).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(revoked))).toBeLessThan(REVIEW_RESULT_LIMIT)
    expect(store.proposal(value.ref)).toBeUndefined()
  })

  test("failed review invalidation rolls back intake and proposal revocation together", () => {
    const store = openStore()
    legacyRecords(store)
    const original = complete()
    store.saveReview(original)
    const proposal = store.proposal(original.ref)
    expect(() =>
      store.acceptDelivery(
        "failed-atomic-revocation",
        {},
        [original.ref],
        [{ ref: { ...original.ref, owner: "wrong-owner" }, reason: "changed" }],
      ),
    ).toThrow()
    expect(store.review(original.ref)).toEqual(original)
    expect(store.proposal(original.ref)).toEqual(proposal)
    expect(store.deliveries().some((delivery) => delivery.id === "failed-atomic-revocation")).toBe(
      false,
    )
  })

  test("recovers running attempts without repeating inference for assessed records", () => {
    let store = openStore()
    const values: Review[] = [
      { ...review(1), state: "running", attempts: 1 },
      { ...review(2), state: "running", attempts: 2, commentId: 102, commentIntent: true },
      { ...review(3), state: "running", attempts: 3, commentId: 103, commentIntent: true },
      { ...assessed(review(4)), commentIntent: true, commentRetryAt: 1_800_000_000_100 },
      complete(assessed(review(5))),
      { ...complete(assessed(review(6))), state: "stale", inactiveReason: "closed" },
    ]
    for (const value of values) store.saveReview(value)
    store.close()
    store = openStore()
    for (const value of values) {
      const expected =
        value.state === "running"
          ? {
              ...value,
              state: value.attempts < 3 ? "pending" : "failed",
              nextAttemptAt:
                value.attempts < 3 ? Date.now() + (value.attempts === 1 ? 60_000 : 300_000) : 0,
              error: "triage_interrupted",
            }
          : value
      expect(store.review(value.ref)).toEqual(expected)
    }
    const recovered = store.reviewBatch(100)
    store.close()
    expect(openStore().reviewBatch(100)).toEqual(recovered)
  })

  test("rolls back all interrupted-attempt recovery when another running row is invalid", () => {
    const store = openStore()
    const first: Review = { ...review(1), state: "running", attempts: 1 }
    const last: Review = { ...review(2), state: "running", attempts: 3 }
    store.saveReview(first)
    store.saveReview(last)
    store.close()
    inspect((db) =>
      db
        .prepare("UPDATE reviews SET json = ? WHERE issue_key = ?")
        .run(JSON.stringify({ ...last, attempts: 0 }), "456:1002"),
    )
    expect(() => openStore()).toThrow("Invalid persisted review record")
    expect(
      inspect((db) =>
        db.prepare("SELECT state,json FROM reviews WHERE issue_key = ?").get("456:1001"),
      ),
    ).toEqual({ state: "running", json: JSON.stringify(first) })
    inspect((db) =>
      db
        .prepare("UPDATE reviews SET json = ? WHERE issue_key = ?")
        .run(JSON.stringify(last), "456:1002"),
    )
    const recovered = openStore()
    expect(recovered.review(first.ref)).toEqual({
      ...first,
      state: "pending",
      nextAttemptAt: Date.now() + 60_000,
      error: "triage_interrupted",
    })
    expect(recovered.review(last.ref)).toEqual({
      ...last,
      state: "failed",
      error: "triage_interrupted",
    })
  })

  test("visits more than one hundred stored reviews without discovery or skipped rows", () => {
    let store = openStore()
    const values = Array.from({ length: 105 }, (_, index) => review(index + 1))
    for (const value of values) store.saveReview(value)
    const first = store.reviewBatch(100)
    expect(first).toHaveLength(100)
    store.close()
    store = openStore()
    const second = store.reviewBatch(100)
    expect(second).toHaveLength(100)
    expect(new Set([...first, ...second].map((value) => value.ref.issueId)).size).toBe(105)
    expect(new Set(second.map((value) => value.ref.issueId)).size).toBe(100)
    expect(store.scanPage()).toBe(1)
  })

  test("rotates a separate persisted cursor and wraps without duplicate rows", () => {
    let store = openStore()
    const values = Array.from({ length: 5 }, (_, index) => review(index + 1))
    for (const value of values) store.saveReview(value)
    store.saveScanPage(17)
    expect(store.reviewBatch(2)).toEqual(values.slice(0, 2))
    store.close()
    store = openStore()
    expect(store.reviewBatch(2)).toEqual(values.slice(2, 4))
    expect(store.reviewBatch(3)).toEqual([values[4], values[0], values[1]])
    const all = store.reviewBatch(100)
    expect(all).toHaveLength(5)
    expect(new Set(all.map((value) => value.ref.issueId)).size).toBe(5)
    expect(store.scanPage()).toBe(17)
    for (const limit of [0, -1, 1.5, 101, Number.NaN, Number.MAX_SAFE_INTEGER])
      expect(() => store.reviewBatch(limit)).toThrow("Invalid review batch limit")
  })

  test("cursor advancement rolls back when a batch has an invalid persisted row", () => {
    const store = openStore()
    for (let number = 1; number <= 3; number++) store.saveReview(review(number))
    store.reviewBatch(1)
    const before = inspect((db) => db.prepare("SELECT * FROM review_cursor").get())
    inspect((db) =>
      db
        .prepare("UPDATE reviews SET revision = ? WHERE issue_key = ?")
        .run(randomUUID(), "456:1003"),
    )
    expect(() => store.reviewBatch(2)).toThrow("Inconsistent review identity")
    expect(inspect((db) => db.prepare("SELECT * FROM review_cursor").get())).toEqual(before)
    for (const invalid of ["invalid", "9007199254740992:1", "1:9007199254740992", "0:1"]) {
      inspect((db) => db.prepare("UPDATE review_cursor SET issue_key = ?").run(invalid))
      expect(() => store.reviewBatch(1)).toThrow("Invalid review cursor record")
    }
  })

  test("identity checks cover lookup references and every persisted index field", () => {
    const store = openStore()
    const value = review()
    store.saveReview(value)
    expect(store.review({ ...value.ref, owner: "EXAMPLE", name: "PROJECT" })).toEqual(value)
    for (const ref of [
      { ...value.ref, installationId: 999 },
      { ...value.ref, number: 999 },
      { ...value.ref, owner: "foreign" },
    ])
      expect(() => store.review(ref)).toThrow("Inconsistent review identity")
    for (const [field, replacement] of [
      ["revision", randomUUID()],
      ["state", "failed"],
      ["issue_key", "456:1002"],
    ]) {
      inspect((db) => db.prepare(`UPDATE reviews SET ${field} = ?`).run(replacement))
      expect(() => store.reviewBatch(100)).toThrow("Inconsistent review identity")
      inspect((db) =>
        db
          .prepare("UPDATE reviews SET issue_key = ?, revision = ?, state = ?")
          .run("456:1001", value.revision, value.state),
      )
    }
    inspect((db) =>
      db
        .prepare("UPDATE reviews SET json = ?")
        .run(JSON.stringify({ ...value, request: "fixture-private-request" })),
    )
    expect(() => store.review(value.ref)).toThrow("Invalid persisted review record")
  })

  test("stores only validated bounded records and no rejected secret or raw data", () => {
    const store = openStore()
    const value = review()
    for (const extra of [
      { token: "fixture-private-token" },
      { snapshot: "fixture-private-snapshot" },
      { rawStream: "fixture-private-stream" },
    ])
      expect(() => store.saveReview({ ...value, ...extra })).toThrow("Invalid review record")
    expect(store.review(value.ref)).toBeUndefined()
    store.saveReview(value)
    store.close()
    const bytes = readFileSync(join(directory, "reina.sqlite"))
    for (const secret of [
      "fixture-private-token",
      "fixture-private-snapshot",
      "fixture-private-stream",
    ])
      expect(bytes.includes(Buffer.from(secret))).toBe(false)
    expect(inspect((db) => db.prepare("SELECT json FROM reviews").all())).toEqual([
      { json: JSON.stringify(value) },
    ])
  })
})

describe("review rename reconciliation", () => {
  test.each(["needs_info", "needs_human"] as const)(
    "reads and rebinds a %s review without a proposal or new authority",
    (outcome) => {
      let store = openStore()
      const value = complete()
      value.outcome = outcome
      value.assessment = {
        ...assessment(),
        kind: "unknown",
        missingInfo: outcome === "needs_info" ? ["Provide reproduction steps."] : [],
        fix: {
          ...assessment().fix,
          eligible: false,
          category: "defer",
          requiresHumanDecision: outcome === "needs_human",
        },
      }
      value.commentRetryAt = Date.now() + 60_000
      store.saveReview(value)
      const liveRef = { ...value.ref, owner: "EXAMPLE", name: "renamed" }
      const before = inspect((db) => db.prepare("SELECT * FROM reviews").all())
      expect(store.reviewForReconciliation(liveRef)).toEqual(value)
      expect(inspect((db) => db.prepare("SELECT * FROM reviews").all())).toEqual(before)
      expect(() => store.review(liveRef)).toThrow("Inconsistent review identity")
      expect(() => store.saveReview({ ...value, ref: liveRef }, value.revision)).toThrow(
        "Invalid review cycle update",
      )
      expect(() =>
        store.acceptDelivery("strict-rename-intake", {}, [], [{ ref: liveRef, reason: "changed" }]),
      ).toThrow("Inconsistent review identity")
      expect(store.deliveries()).toEqual([])
      const rebound = store.rebindReview(liveRef, value.revision)
      expect(rebound).toEqual({
        ...value,
        ref: { ...value.ref, name: liveRef.name },
        revision: expect.any(String),
        state: "stale",
        inactiveReason: "changed",
        publishedRevision: undefined,
      })
      expect(rebound?.revision).not.toBe(value.revision)
      expect(store.proposal(liveRef)).toBeUndefined()
      expect(store.proposals()).toEqual([])
      expect(store.jobs()).toEqual([])
      expect(store.saveReview(value, value.revision)).toBe(false)
      expect(() => store.review(value.ref)).toThrow("Inconsistent review identity")
      expect(store.reviewForReconciliation(value.ref)).toEqual(rebound)
      store.close()
      store = openStore()
      expect(store.review(liveRef)).toEqual(rebound)
    },
  )

  test.each([
    { state: "failed", attempts: 3, error: "runtime_timeout", nextAttemptAt: 0 },
    { state: "failed", attempts: 1, error: "triage_invalid_output", nextAttemptAt: 0 },
    { state: "pending", attempts: 2, error: "runtime_timeout", nextAttemptAt: 1_800_000_300_000 },
  ] as const)("preserves the $state attempt budget and error after rename", (budget) => {
    const store = openStore()
    const value: Review = {
      ...review(),
      ...budget,
      commentIntent: true,
      commentId: 101,
      commentRetryAt: Date.now() + 60_000,
      publishedRevision: randomUUID(),
    }
    store.saveReview(value)
    const rebound = store.rebindReview({ ...value.ref, name: "renamed" }, value.revision)
    expect(rebound).toMatchObject({
      ...budget,
      state: "stale",
      inactiveReason: "changed",
      binding: value.binding,
      createdAt: value.createdAt,
      commentIntent: true,
      commentId: 101,
      commentRetryAt: value.commentRetryAt,
    })
    expect(rebound?.publishedRevision).toBeUndefined()
    expect(rebound?.revision).not.toBe(value.revision)
  })

  test("always changes an already-stale revision and requires a fresh binding cycle", () => {
    const store = openStore()
    const value: Review = {
      ...complete(),
      state: "stale",
      inactiveReason: "changed",
      updatedAt: Date.now() + 1_000,
    }
    store.saveReview(value)
    const liveRef = { ...value.ref, name: "renamed" }
    const rebound = store.rebindReview(liveRef, value.revision)
    if (!rebound) throw new Error("Missing rebound review")
    expect(rebound.revision).not.toBe(value.revision)
    expect(rebound.publishedRevision).toBeUndefined()
    expect(rebound.binding).toEqual(value.binding)
    expect(rebound.updatedAt).toBe(value.updatedAt)
    expect(store.saveReview({ ...value, ref: liveRef }, value.revision)).toBe(false)
    const binding = { ...rebound.binding, policyHash: "e".repeat(64) }
    expect(() => store.saveReview({ ...rebound, binding }, rebound.revision)).toThrow(
      "Invalid review cycle update",
    )
    const fresh = {
      ...review(),
      ref: liveRef,
      revision: randomUUID(),
      binding,
      createdAt: rebound.updatedAt,
      updatedAt: rebound.updatedAt,
      commentId: rebound.commentId,
      commentIntent: rebound.commentIntent,
    }
    expect(store.saveReview(fresh, rebound.revision)).toBe(true)
    expect(store.review(liveRef)).toEqual(fresh)
  })

  test("atomically revokes proposals and cancels active work without rebinding old authority", () => {
    let store = openStore()
    legacyRecords(store, true)
    const value = complete()
    store.saveReview(value)
    const oldJob = store.jobs()[0]
    if (!oldJob) throw new Error("Missing fixture job")
    const immutable = () =>
      inspect((db) => ({
        proposals: db.prepare("SELECT * FROM proposals ORDER BY rowid").all(),
        heads: db.prepare("SELECT * FROM proposal_heads ORDER BY rowid").all(),
        approvals: db.prepare("SELECT * FROM approvals ORDER BY rowid").all(),
      }))
    const before = immutable()
    const liveRef = { ...value.ref, owner: "EXAMPLE", name: "renamed" }
    expect(() => store.proposal(liveRef)).toThrow("Inconsistent proposal identity")
    const rebound = store.rebindReview(liveRef, value.revision)
    expect(immutable()).toEqual({
      ...before,
      proposals: before.proposals.map((row) => ({ ...row, valid: 0 })),
    })
    const cancelled = {
      ...oldJob,
      state: "cancelled",
      error: "authority_revoked",
    }
    expect(store.job(oldJob.id)).toEqual(cancelled)
    expect(store.job(oldJob.id)?.ref).toEqual(value.ref)
    expect(store.proposal(value.ref)).toBeUndefined()
    expect(store.proposal(liveRef)).toBeUndefined()
    expect(() => store.saveJob({ ...oldJob, ref: liveRef })).toThrow("Job authority is immutable")
    const oldProposal = JSON.parse(String(before.proposals[0]?.json)) as Proposal
    expect(() => store.saveProposal({ ...oldProposal, ref: liveRef })).toThrow(
      "Proposal authority is immutable",
    )
    expect(
      store.claim(oldProposal, { ...oldJob.approval, eventId: "late-approval" }),
    ).toBeUndefined()
    expect(store.saveReview(complete(assessed(value)), value.revision)).toBe(false)
    store.close()
    store = openStore()
    expect(store.job(oldJob.id)).toEqual(cancelled)
    expect(store.review(liveRef)).toEqual(rebound)
  })

  test("rolls back proposal revocation and active job cancellation if the review write fails", () => {
    const store = openStore()
    legacyRecords(store, true)
    const value = complete()
    store.saveReview(value)
    const before = preservedRows()
    inspect((db) =>
      db.exec(`CREATE TRIGGER reject_review_rebind BEFORE UPDATE ON reviews
        BEGIN SELECT RAISE(ABORT, 'fixture_rebind_failure'); END;`),
    )
    expect(() => store.rebindReview({ ...value.ref, name: "renamed" }, value.revision)).toThrow(
      "fixture_rebind_failure",
    )
    expect(preservedRows()).toEqual(before)
    expect(store.review(value.ref)).toEqual(value)
  })

  test("matching names are a read-only no-op, but still require the current revision", () => {
    const store = openStore()
    legacyRecords(store, true)
    const value = complete()
    store.saveReview(value)
    const before = preservedRows()
    const rows = inspect((db) => db.prepare("SELECT * FROM reviews").all())
    expect(
      store.rebindReview({ ...value.ref, owner: "EXAMPLE", name: "PROJECT" }, value.revision),
    ).toEqual(value)
    expect(store.rebindReview(value.ref, randomUUID())).toBeUndefined()
    expect(store.rebindReview({ ...value.ref, name: "renamed" }, randomUUID())).toBeUndefined()
    expect(preservedRows()).toEqual(before)
    expect(inspect((db) => db.prepare("SELECT * FROM reviews").all())).toEqual(rows)
    const liveRef = { ...value.ref, name: "renamed" }
    const rebound = store.rebindReview(liveRef, value.revision)
    if (!rebound) throw new Error("Missing rebound review")
    const after = preservedRows()
    expect(store.rebindReview(liveRef, rebound.revision)).toEqual(rebound)
    expect(store.rebindReview(liveRef, value.revision)).toBeUndefined()
    expect(preservedRows()).toEqual(after)
    expect(store.review(liveRef)).toEqual(rebound)
  })

  test.each([
    { owner: "other-owner" },
    { installationId: 999 },
    { number: 999 },
    { id: 999 },
    { issueId: 999 },
  ])("rejects a pinned-field mismatch %j without mutations", (mismatch) => {
    const store = openStore()
    legacyRecords(store, true)
    const value = complete()
    store.saveReview(value)
    const before = preservedRows()
    const rows = inspect((db) => db.prepare("SELECT * FROM reviews").all())
    const liveRef = { ...value.ref, name: "renamed", ...mismatch }
    if (liveRef.id !== value.ref.id || liveRef.issueId !== value.ref.issueId) {
      expect(store.reviewForReconciliation(liveRef)).toBeUndefined()
      expect(store.rebindReview(liveRef, value.revision)).toBeUndefined()
    } else {
      expect(() => store.reviewForReconciliation(liveRef)).toThrow("Inconsistent review identity")
      expect(() => store.rebindReview(liveRef, value.revision)).toThrow(
        "Inconsistent review identity",
      )
    }
    expect(preservedRows()).toEqual(before)
    expect(inspect((db) => db.prepare("SELECT * FROM reviews").all())).toEqual(rows)
  })

  test("validates live references, CAS revisions, and the whole rebound record", () => {
    const store = openStore()
    legacyRecords(store, true)
    const value = complete()
    store.saveReview(value)
    const before = preservedRows()
    for (const ref of [
      { ...value.ref, name: "" },
      { ...value.ref, name: "x".repeat(101) },
      { ...value.ref, installationId: 0 },
      { ...value.ref, name: "renamed\n" },
    ]) {
      expect(() => store.rebindReview(ref, value.revision)).toThrow()
      expect(store.review(value.ref)).toEqual(value)
      expect(preservedRows()).toEqual(before)
    }
    expect(() => store.rebindReview(value.ref, "invalid-revision")).toThrow(
      "Invalid review revision record",
    )
    inspect((db) => db.prepare("UPDATE reviews SET revision = ?").run(randomUUID()))
    expect(() => store.reviewForReconciliation(value.ref)).toThrow("Inconsistent review identity")
    expect(() => store.rebindReview(value.ref, value.revision)).toThrow(
      "Inconsistent review identity",
    )
    expect(preservedRows()).toEqual(before)
  })

  test("compacts restored large results before adding rename metadata", () => {
    const store = openStore()
    const value = nearLimitReview()
    value.commentRetryAt = Date.now() + 60_000
    store.saveReview(value)
    const liveRef = { ...value.ref, name: "r".repeat(100) }
    const rebound = store.rebindReview(liveRef, value.revision)
    expect(rebound).toMatchObject({
      ref: liveRef,
      state: "stale",
      inactiveReason: "changed",
      error: "triage_invalid_output",
      binding: value.binding,
      attempts: value.attempts,
      commentId: value.commentId,
      commentIntent: value.commentIntent,
      commentRetryAt: value.commentRetryAt,
    })
    expect(rebound?.revision).not.toBe(value.revision)
    expect(rebound?.assessment).toBeUndefined()
    expect(rebound?.outcome).toBeUndefined()
    expect(rebound?.assessedAt).toBeUndefined()
    expect(rebound?.publishedRevision).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(rebound))).toBeLessThan(REVIEW_RESULT_LIMIT)
    expect(reviewSchema.safeParse(rebound).success).toBe(true)
    expect(store.review(liveRef)).toEqual(rebound)
  })
})

describe("schema5 migrations and private files", () => {
  test.each([1, 2, 3, 4])(
    "migrates legacy schema%s atomically and preserves existing records and settings",
    (version) => {
      let store = openStore()
      legacyRecords(store)
      store.close()
      const before = preservedRows()
      const settings = new DatabaseSync(join(directory, "settings.sqlite"))
      settings.exec("CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('unchanged');")
      settings.close()
      const settingsBefore = readFileSync(join(directory, "settings.sqlite"))
      downgrade(version)
      store = openStore()
      expect(preservedRows()).toEqual(before)
      expect(readFileSync(join(directory, "settings.sqlite"))).toEqual(settingsBefore)
      expect(store.reviewBatch(100)).toEqual([])
      expect(store.review(review().ref)).toBeUndefined()
      expect(store.scanPage()).toBe(version < 3 ? 1 : 17)
      expect(store.assessed("legacy-attempt-not-success")).toBe(version !== 1)
      expect(inspect((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(5)
      const delivery = inspect((db) => db.prepare("SELECT * FROM deliveries").get())
      expect(delivery).toMatchObject({
        id: "fixture-delivery",
        status: "pending",
        attempts: 1,
        global_until: version < 4 ? delivery?.available_at : 0,
      })
      const pending = review()
      expect(store.saveReview(pending)).toBe(true)
      store.close()
      expect(openStore().review(pending.ref)).toEqual(pending)
    },
  )

  test.each([1, 2, 3, 4])(
    "rolls back every migration step when schema%s cannot create review storage",
    (version) => {
      const store = openStore()
      legacyRecords(store)
      store.close()
      downgrade(version)
      inspect((db) =>
        db.exec(
          "CREATE TABLE review_cursor (fixture TEXT); INSERT INTO review_cursor VALUES ('unchanged');",
        ),
      )
      const before = inspect((db) => ({
        schema: db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all(),
        delivery: db.prepare("SELECT * FROM deliveries").all(),
        records: preservedRows(),
      }))
      expect(() => openStore()).toThrow()
      expect(inspect((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(version)
      expect(
        inspect((db) => ({
          schema: db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all(),
          delivery: db.prepare("SELECT * FROM deliveries").all(),
          records: preservedRows(),
        })),
      ).toEqual(before)
      inspect((db) => db.exec("DROP TABLE review_cursor"))
      expect(openStore().reviewBatch(1)).toEqual([])
    },
  )

  test("rolls back a failed fresh migration and rejects unsupported versions", () => {
    inspect((db) => db.exec("CREATE TABLE review_cursor (fixture TEXT);"))
    expect(() => openStore()).toThrow()
    expect(inspect((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(0)
    expect(
      inspect((db) => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()),
    ).toEqual([{ name: "review_cursor" }])
    inspect((db) => db.exec("DROP TABLE review_cursor; PRAGMA user_version = 6;"))
    expect(() => openStore()).toThrow("Unsupported state database version")
    expect(inspect((db) => db.prepare("PRAGMA user_version").get()?.user_version)).toBe(6)
  })

  test("preserves private permissions for the job database and lock", () => {
    let store = openStore()
    store.saveReview(assessed())
    store.close()
    chmodSync(directory, 0o755)
    for (const name of ["reina.sqlite", "instance.sqlite"]) chmodSync(join(directory, name), 0o644)
    store = openStore()
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    for (const name of ["reina.sqlite", "instance.sqlite"])
      expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600)
    expect(store.reviewBatch(1)[0]?.state).toBe("assessed")
  })

  test.each(["symlink", "hardlink"])(
    "rejects a %s job database without touching the target",
    (kind) => {
      const target = join(directory, "target.sqlite")
      const db = new DatabaseSync(target)
      db.exec("CREATE TABLE fixture (value TEXT);")
      db.close()
      const before = readFileSync(target)
      if (kind === "symlink") symlinkSync(target, join(directory, "reina.sqlite"))
      else linkSync(target, join(directory, "reina.sqlite"))
      expect(() => openStore()).toThrow("Unsafe state file")
      expect(readFileSync(target)).toEqual(before)
    },
  )
})
