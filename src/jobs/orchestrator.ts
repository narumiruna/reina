import { randomUUID } from "node:crypto"
import { z } from "zod"
import { authorize } from "../github/approval.js"
import type { Publisher } from "../github/publisher.js"
import {
  errorStatus,
  type GitHub,
  GitHubDeferred,
  GitHubError,
  GitHubIssueDeferred,
  sameRepository,
} from "../github/scanner.js"
import { fingerprint, makeProposal, policyHash } from "../triage/policy.js"
import type { Review, ReviewInvalidation } from "../triage/review.js"
import type { AgentRuntime, Config, Issue, IssueRef, Job, Logger, Proposal } from "../types.js"
import type { Store } from "./store.js"
import { IssueTriage } from "./triage.js"
import { Worker } from "./worker.js"

const refSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
  id: z.number().int().positive(),
  installationId: z.number().int().positive(),
  number: z.number().int().positive(),
  issueId: z.number().int().positive(),
})
const actorSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  type: z.string(),
})
export const workSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("issue"),
    ref: refSchema,
    action: z.string(),
    label: z.string().optional(),
    actor: actorSchema.optional(),
    material: z.boolean(),
    cancel: z.boolean(),
  }),
  z.object({ kind: z.literal("review"), ref: refSchema }),
  z.object({ kind: z.literal("scan"), reason: z.string() }),
  z.object({ kind: z.literal("invalidate"), branch: z.string().optional(), disable: z.boolean() }),
])
export type Work = z.infer<typeof workSchema>
export interface Boundaries {
  github: GitHub
  publisher: Publisher
}

const key = (ref: IssueRef) => `${ref.id}:${ref.issueId}`
const terminal = new Set(["pr_ready", "cancelled", "failed"])
const reasons = new Set([
  "proposal_stale",
  "base_changed",
  "job_cancelled",
  "service_stopping",
  "verification_failed",
  "artifact_invalid",
  "runtime_timeout",
  "runtime_cancelled",
  "runtime_controls_unavailable",
  "runtime_preflight_required",
  "worker_dependency_fingerprint_mismatch",
  "worker_image_not_prepared",
  "worker_pi_version_mismatch",
  "docker_operation_failed",
  "docker_unavailable",
  "container_cleanup_failed",
  "pi_agent_error",
  "pi_aborted",
  "pi_incomplete",
  "pi_malformed_json",
  "pi_stdout_limit",
  "pi_stderr_limit",
  "pi_record_limit",
  "pi_exit_failure",
  "pi_unterminated_record",
  "artifact_binary_change",
  "artifact_file_mode",
  "artifact_invalid_scope",
  "artifact_outside_scope",
  "artifact_file_limit",
  "artifact_diff_limit",
  "artifact_no_changes",
  "artifact_unsafe_path",
  "artifact_nonregular_file",
  "artifact_dependencies_changed",
  "artifact_size_limit",
  "artifact_invalid_tar",
])

function failureReason(error: unknown): string {
  if (
    error instanceof GitHubError &&
    /^(?:github|approval|publication)_[a-z0-9_]{1,64}$/.test(error.code)
  )
    return error.code
  return error instanceof Error && reasons.has(error.message) ? error.message : "execution_failed"
}

export class Orchestrator {
  private draining?: Promise<void>
  private shutdown = new AbortController()
  private disabled = false
  private timer?: ReturnType<typeof setInterval>
  private scanTimer?: ReturnType<typeof setInterval>
  private controllers = new Map<string, AbortController>()
  private controllerBranches = new Map<string, string>()
  private controllerRefs = new Map<string, IssueRef>()
  private worker: Worker
  private reviews: IssueTriage

  constructor(
    private config: Config,
    private store: Store,
    private runtime: AgentRuntime,
    private boundaries: () => Promise<Boundaries>,
    private botId: number,
    private log: Logger,
  ) {
    this.worker = new Worker(config, store, runtime, botId, log)
    this.reviews = new IssueTriage(config, store, runtime, botId, (event, ref, fields) =>
      this.event(event, ref, fields),
    )
  }

  private event(event: string, ref?: IssueRef, extra: Record<string, unknown> = {}): void {
    const level = ["failed", "execution_failed", "recovery_failed", "triage_failed"].includes(event)
      ? "error"
      : "info"
    this.log[level]({
      event,
      repository: `${this.config.repository.owner}/${this.config.repository.name}`,
      repositoryId: this.config.repository.id,
      installationId: this.config.repository.installationId,
      issue: ref?.number,
      ...extra,
    })
  }

  accept(deliveryId: string, work: Work): void {
    if (this.stopped) throw new Error("service_stopping")
    const validated = workSchema.parse(work)
    if (validated.kind === "issue" && !this.enabled(validated.ref)) return
    const revoked =
      validated.kind === "issue" && (validated.cancel || validated.material)
        ? [validated.ref]
        : validated.kind === "invalidate"
          ? this.store
              .proposals()
              .filter((proposal) => !validated.branch || proposal.baseBranch === validated.branch)
              .map((proposal) => proposal.ref)
          : []
    const invalidations = new Map<string, ReviewInvalidation>()
    if (validated.kind === "issue" && (validated.material || validated.cancel)) {
      invalidations.set(key(validated.ref), {
        ref: validated.ref,
        reason:
          validated.action === "closed"
            ? "closed"
            : validated.label === "bot:skip"
              ? "skipped"
              : validated.action === "deleted"
                ? "unavailable"
                : "changed",
      })
    }
    if (validated.kind === "invalidate") {
      const reason = validated.disable ? "unavailable" : "changed"
      for (const ref of revoked) invalidations.set(key(ref), { ref, reason })
      for (const [issueKey, ref] of this.controllerRefs) {
        if (!validated.branch || this.controllerBranches.get(issueKey) === validated.branch)
          invalidations.set(issueKey, { ref, reason })
      }
    }
    // A rename may be pending live validation. Revoke the stored reference
    // without rebinding it from untrusted webhook data.
    for (const [issueKey, invalidation] of invalidations) {
      const stored = this.store.reviewForReconciliation(invalidation.ref)
      if (stored) invalidations.set(issueKey, { ...invalidation, ref: stored.ref })
    }
    if (
      !this.store.acceptDelivery(deliveryId, JSON.parse(JSON.stringify(validated)), revoked, [
        ...invalidations.values(),
      ])
    )
      return
    for (const { ref, reason } of invalidations.values()) {
      const review = this.store.review(ref)
      if (review)
        this.event("triage_stale", ref, {
          correlationId: deliveryId,
          revision: review.revision,
          reason,
        })
    }
    for (const ref of revoked) this.cancel(ref, true)
    if (validated.kind === "invalidate") {
      if (validated.disable) this.disabled = true
      for (const [issueKey, controller] of this.controllers) {
        if (!validated.branch || this.controllerBranches.get(issueKey) === validated.branch) {
          controller.abort(new Error("job_cancelled"))
        }
      }
    }
    void this.drain()
  }

  private get stopped(): boolean {
    return this.shutdown.signal.aborted
  }

  private enabled(ref: IssueRef): boolean {
    return sameRepository(ref, this.config.repository)
  }

  private cancel(ref: IssueRef, alreadyInvalidated = false): void {
    if (!alreadyInvalidated) this.store.cancel(ref)
    this.controllers.get(key(ref))?.abort(new Error("job_cancelled"))
    this.event("cancelled", ref)
  }

  async start(): Promise<void> {
    await this.runtime.cleanup()
    if (this.stopped) return
    await this.runtime.preflight()
    if (this.stopped) return
    try {
      await this.recover()
    } catch (error) {
      if (!(error instanceof GitHubDeferred)) throw error
      const id = `recovery-${randomUUID()}`
      this.store.acceptDelivery(id, { kind: "scan", reason: "publication_recovery" })
      this.store.deferDelivery(id, Math.max(1_000, Math.ceil(error.retryAt - Date.now())))
    }
    if (this.stopped) return
    this.timer = setInterval(() => {
      void this.drain()
    }, 1_000)
    this.scanTimer = setInterval(() => this.scan(), this.config.scanIntervalMs)
    this.timer.unref()
    this.scanTimer.unref()
    this.scan()
  }

  scan(): void {
    if (this.stopped || this.disabled) return
    if (
      this.store
        .deliveries()
        .some((item) => workSchema.safeParse(item.payload).data?.kind === "scan")
    )
      return
    this.accept(`scan-${randomUUID()}`, { kind: "scan", reason: "periodic" })
  }

  async drain(): Promise<void> {
    if (this.draining) return this.draining
    this.draining = this.process()
      .catch(() => {
        this.log.error({ event: "dispatch_failed", reason: "state_or_dispatch_unavailable" })
      })
      .finally(() => {
        this.draining = undefined
      })
    return this.draining
  }

  private async process(): Promise<void> {
    while (!this.stopped) {
      if (this.store.blockedUntil() > Date.now()) return
      const delivery = this.store.deliveries()[0]
      if (!delivery) return
      const parsed = workSchema.safeParse(delivery.payload)
      if (!parsed.success) {
        this.store.completeDelivery(delivery.id)
        continue
      }
      const work = parsed.data
      try {
        if (work.kind === "issue" && !this.disabled) await this.issue(work, delivery.id)
        if (work.kind === "review" && !this.disabled) {
          await this.issue(
            { kind: "issue", ref: work.ref, action: "reconcile", material: false, cancel: false },
            delivery.id,
          )
        }
        if (work.kind === "invalidate" && !this.disabled) {
          this.store.acceptDelivery(`${delivery.id}-reviews`, {
            kind: "scan",
            reason: "repository_changed",
          })
        }
        if (work.kind === "scan" && !this.disabled) {
          const { github } = await this.boundaries()
          if (this.stopped) return
          for (const review of this.store.reviewBatch(this.config.maxIssuesPerScan)) {
            this.store.acceptDelivery(`${delivery.id}-review-${review.ref.issueId}`, {
              kind: "review",
              ref: review.ref,
            } satisfies Work)
          }
          const batch = await github.discover(this.config.maxIssuesPerScan, this.store.scanPage())
          for (const number of batch.numbers) {
            if (this.stopped) return
            let issue: Issue
            try {
              issue = await github.issue(number)
            } catch (error) {
              if (!(error instanceof GitHubIssueDeferred)) throw error
              this.event("deferred", undefined, {
                correlationId: delivery.id,
                issue: number,
                reason: error.code,
              })
              continue
            }
            if (this.stopped) return
            if (
              issue.state === "open" &&
              !issue.pullRequest &&
              !issue.labels.includes("bot:skip")
            ) {
              this.store.acceptDelivery(`${delivery.id}-${number}`, {
                kind: "issue",
                ref: issue.ref,
                action: "scan",
                material: false,
                cancel: false,
              } satisfies Work)
            }
          }
          if (this.stopped) return
          this.store.saveScanPage(batch.nextPage)
          await this.recover()
        }
        if (this.stopped) return
        this.store.completeDelivery(delivery.id)
      } catch (error) {
        const retryAt =
          error instanceof GitHubDeferred || error instanceof GitHubIssueDeferred
            ? error.retryAt
            : undefined
        if (retryAt !== undefined) {
          const delay = Math.max(1_000, Math.ceil(retryAt - Date.now()))
          if (Number.isSafeInteger(Date.now() + delay))
            this.store.deferDelivery(
              delivery.id,
              delay,
              error instanceof GitHubIssueDeferred ? "issue" : "global",
            )
          else this.store.completeDelivery(delivery.id)
          this.event("deferred", work.kind === "issue" ? work.ref : undefined, {
            correlationId: delivery.id,
            reason:
              error instanceof GitHubIssueDeferred ? error.code : "github_rate_or_transient_limit",
          })
        } else {
          if (this.stopped) return
          this.store.completeDelivery(delivery.id)
          const event =
            error instanceof GitHubIssueDeferred
              ? "deferred"
              : error instanceof Error &&
                  ["proposal_stale", "base_changed", "job_cancelled", "runtime_cancelled"].includes(
                    error.message,
                  )
                ? "cancelled"
                : "failed"
          this.event(event, work.kind === "issue" ? work.ref : undefined, {
            correlationId: delivery.id,
            reason:
              error instanceof GitHubIssueDeferred
                ? error.code
                : error instanceof Error && reasons.has(error.message)
                  ? error.message
                  : "request_rejected_or_failed",
          })
        }
      }
    }
  }

  private async issue(
    work: Extract<Work, { kind: "issue" }>,
    correlationId: string,
  ): Promise<void> {
    const { github, publisher } = await this.boundaries()
    if (this.stopped) return
    let issue: Issue
    try {
      issue = await github.issue(work.ref.number)
    } catch (error) {
      const stored = this.store.reviewForReconciliation(work.ref)
      if (
        stored &&
        (error instanceof GitHubIssueDeferred || [404, 410].includes(errorStatus(error) ?? 0))
      ) {
        const invalidated = this.reviews.invalidate(stored.ref, "unavailable", correlationId)
        if (invalidated) {
          const review: Review = {
            ...invalidated,
            evidenceError:
              error instanceof GitHubIssueDeferred
                ? "triage_evidence_unavailable"
                : "triage_issue_unavailable",
            updatedAt: Math.max(Date.now(), invalidated.updatedAt),
          }
          if (!this.store.saveReview(review, invalidated.revision)) throw new Error("triage_stale")
          try {
            await this.reviews.project(review, publisher, this.shutdown.signal, correlationId)
          } catch (publication) {
            if (publication instanceof GitHubDeferred) throw publication
            this.event("deferred", work.ref, {
              correlationId,
              revision: review.revision,
              reason: "triage_projection_unavailable",
            })
          }
        }
      }
      throw error
    }
    if (this.stopped) return
    if (
      !this.enabled(issue.ref) ||
      !sameRepository({ ...work.ref, name: issue.ref.name }, issue.ref) ||
      issue.ref.issueId !== work.ref.issueId ||
      issue.ref.number !== work.ref.number
    )
      throw new Error("issue_identity_changed")
    // GitHub.issue() validates the live installation, repository and issue.
    // Only this trusted read can authorize a stored review's name change.
    const previous = this.store.reviewForReconciliation(issue.ref)
    if (previous && previous.ref.name.toLowerCase() !== issue.ref.name.toLowerCase()) {
      const rebound = this.store.rebindReview(issue.ref, previous.revision)
      if (!rebound) throw new Error("job_cancelled")
      this.event("triage_stale", issue.ref, {
        correlationId,
        revision: rebound.revision,
        reason: "repository_renamed",
      })
    }
    this.event("discovered", issue.ref, { correlationId })
    if (issue.state !== "open" || issue.pullRequest || issue.labels.includes("bot:skip")) {
      this.cancel(issue.ref)
      await this.reviews.inactive(
        issue.ref,
        issue.state === "closed"
          ? "closed"
          : issue.labels.includes("bot:skip")
            ? "skipped"
            : "unavailable",
        publisher,
        this.shutdown.signal,
        correlationId,
      )
      await publisher.labels(issue.ref.number, [], ["fix_available", "bot:approved", "bot:working"])
      return
    }
    let proposal = this.store.proposal(issue.ref)
    const head = await github.head()
    if (this.stopped) return
    if (
      proposal &&
      (proposal.fingerprint !== fingerprint(issue, this.botId) ||
        proposal.baseSha !== head.sha ||
        proposal.baseBranch !== head.branch ||
        proposal.policyHash !== policyHash(this.config) ||
        proposal.image !== this.config.image ||
        proposal.expiresAt <= Date.now())
    ) {
      this.cancel(issue.ref)
      await publisher.labels(issue.ref.number, [], ["fix_available", "bot:approved", "bot:working"])
      proposal = undefined
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal])
    this.controllers.set(key(issue.ref), controller)
    this.controllerBranches.set(key(issue.ref), head.branch)
    this.controllerRefs.set(key(issue.ref), issue.ref)
    let review: Awaited<ReturnType<IssueTriage["run"]>>
    try {
      review = await this.reviews.run(issue, head, github, publisher, signal, correlationId)
    } finally {
      if (this.controllers.get(key(issue.ref)) === controller) {
        this.controllers.delete(key(issue.ref))
        this.controllerBranches.delete(key(issue.ref))
        this.controllerRefs.delete(key(issue.ref))
      }
    }
    if (this.stopped || signal.aborted || review?.state !== "complete") return
    const existing = this.store
      .jobs()
      .find((job) => key(job.ref) === key(issue.ref) && job.state === "pr_ready")
    if (existing) {
      await publisher.labels(issue.ref.number, ["bot:pr_ready"], ["bot:working", "bot:failed"])
      return
    }
    if (work.cancel) {
      await publisher.labels(issue.ref.number, [], ["fix_available", "bot:working"])
      return
    }
    if (review.outcome !== "fix_candidate") {
      if (proposal) this.cancel(issue.ref)
      await publisher.labels(issue.ref.number, [], ["fix_available", "bot:approved", "bot:working"])
      return
    }
    if (proposal && !proposal.commentId) {
      Object.assign(
        proposal,
        await publisher.propose(proposal, (value) => this.store.saveProposal(value)),
      )
      this.store.saveProposal(proposal)
      await publisher.labels(issue.ref.number, ["fix_available"], ["bot:failed"])
    }
    if (proposal && !issue.labels.includes("fix_available")) {
      await publisher.labels(issue.ref.number, ["fix_available"], [])
    }
    if (proposal && work.action === "labeled" && work.label === "bot:approved") {
      if (!work.actor) throw new Error("actor_missing")
      const approval = await authorize(github, issue, proposal, work.actor)
      if (this.stopped) return
      const job = this.store.claim(proposal, approval)
      if (!job) return
      this.event("approved", issue.ref, {
        correlationId,
        jobId: job.id,
        proposalId: proposal.revision,
        actorId: approval.actor.id,
      })
      await this.execute(job, proposal, github, publisher)
      return
    }
    if (proposal) return
    // Scanning a label is not permission to execute; a new proposal needs a new human transition.
    if (issue.labels.includes("bot:approved"))
      await publisher.labels(issue.ref.number, [], ["bot:approved"])
    if ((await github.conflicts(issue.ref.number)) || this.stopped) return
    const snapshot = await github.snapshotAt(head.branch, head.sha)
    const current = await github.issue(issue.ref.number)
    const currentHead = await github.head()
    if (
      this.stopped ||
      current.state !== "open" ||
      current.labels.includes("bot:skip") ||
      fingerprint(current, this.botId) !== review.binding.fingerprint ||
      currentHead.sha !== review.binding.baseSha ||
      currentHead.branch !== review.binding.baseBranch ||
      this.store.review(issue.ref)?.revision !== review.revision
    )
      return
    if (
      !review.assessment ||
      review.assessedAt === undefined ||
      review.assessedAt + 86_400_000 <= Date.now()
    )
      return
    proposal = makeProposal(
      current,
      snapshot,
      review.assessment.fix,
      this.config,
      this.botId,
      review.assessedAt,
      review.revision,
    )
    this.store.saveProposal(proposal)
    Object.assign(
      proposal,
      await publisher.propose(proposal, (value) => this.store.saveProposal(value)),
    )
    this.store.saveProposal(proposal)
    await publisher.labels(issue.ref.number, ["fix_available"], ["bot:failed", "bot:working"])
    this.event("proposal_created", issue.ref, { correlationId, proposalId: proposal.revision })
  }

  private async execute(
    job: Job,
    proposal: Proposal,
    github: GitHub,
    publisher: Publisher,
  ): Promise<void> {
    if (this.stopped) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal])
    this.controllers.set(key(job.ref), controller)
    this.controllerBranches.set(key(job.ref), proposal.baseBranch)
    this.controllerRefs.set(key(job.ref), job.ref)
    this.event("dispatched", job.ref, { jobId: job.id, proposalId: proposal.revision })
    try {
      await this.worker.run(job, proposal, github, publisher, signal)
      const current = this.store.job(job.id)
      if (current?.state === "pr_ready") {
        current.notified = true
        current.updatedAt = Date.now()
        this.store.saveJob(current)
      }
      this.event("pr_created", job.ref, {
        jobId: job.id,
        prUrl: this.store.job(job.id)?.publication?.prUrl,
      })
    } catch (error) {
      const current = this.store.job(job.id)
      if (error instanceof GitHubDeferred) {
        if (current && !terminal.has(current.state) && current.state !== "publishing") {
          current.state = "failed"
          current.updatedAt = Math.max(current.updatedAt, Date.now())
          current.error = "github_deferred"
          this.store.saveJob(current)
        }
        this.event("execution_deferred", job.ref, { jobId: job.id, reason: error.code })
        // Do not make even a label request until the dispatcher persists this cooldown.
        throw error
      }
      const notify = current && !terminal.has(current.state)
      if (notify) {
        const revoked =
          signal.aborted ||
          (error instanceof Error &&
            ["proposal_stale", "base_changed", "job_cancelled"].includes(error.message)) ||
          (error instanceof GitHubError &&
            (error.code.startsWith("approval_") || error.code === "publication_base_changed"))
        if (current.state !== "publishing" || revoked) {
          current.state = revoked ? "cancelled" : "failed"
          current.updatedAt = Date.now()
          current.error = failureReason(error)
          this.store.saveJob(current)
        }
      }
      this.event(
        current?.state === "cancelled"
          ? "execution_cancelled"
          : error instanceof GitHubIssueDeferred
            ? "execution_deferred"
            : "execution_failed",
        job.ref,
        {
          jobId: job.id,
          reason: failureReason(error),
        },
      )
      if (notify) {
        await publisher.labels(
          job.ref.number,
          current.state === "cancelled" ? [] : ["bot:failed"],
          ["bot:working"],
        )
        if (terminal.has(current.state)) {
          current.notified = true
          this.store.saveJob(current)
        }
      }
    } finally {
      if (this.controllers.get(key(job.ref)) === controller) {
        this.controllers.delete(key(job.ref))
        this.controllerBranches.delete(key(job.ref))
        this.controllerRefs.delete(key(job.ref))
      }
    }
  }

  private async recover(): Promise<void> {
    const jobs = this.store.jobs()
    for (const job of jobs.filter((job) => !job.notified).slice(0, this.config.maxIssuesPerScan)) {
      if (this.stopped || this.disabled || this.store.blockedUntil() > Date.now()) return
      if (
        terminal.has(job.state) &&
        jobs.some((other) => key(other.ref) === key(job.ref) && other.createdAt > job.createdAt)
      ) {
        job.notified = true
        job.updatedAt = Date.now()
        this.store.saveJob(job)
        continue
      }
      try {
        const { github, publisher } = await this.boundaries()
        if (this.stopped) return
        if (job.state === "publishing") {
          const proposal = this.store.proposal(job.ref)
          if (proposal) await this.execute(job, proposal, github, publisher)
        } else if (job.state === "failed" || job.state === "cancelled") {
          await publisher.labels(job.ref.number, job.state === "failed" ? ["bot:failed"] : [], [
            "bot:working",
          ])
          job.notified = true
          job.updatedAt = Date.now()
          this.store.saveJob(job)
        } else if (job.state === "pr_ready") {
          await publisher.labels(job.ref.number, ["bot:pr_ready"], ["bot:working", "bot:failed"])
          job.notified = true
          job.updatedAt = Date.now()
          this.store.saveJob(job)
        }
      } catch (error) {
        if (error instanceof GitHubDeferred) throw error
        const current = this.store.job(job.id)
        if (current && terminal.has(current.state) && errorStatus(error) === 404) {
          current.notified = true
          current.updatedAt = Math.max(current.updatedAt, Date.now())
          this.store.saveJob(current)
        }
        this.event("recovery_failed", job.ref, { jobId: job.id, reason: failureReason(error) })
      }
    }
  }

  async stop(): Promise<void> {
    this.shutdown.abort(new Error("service_stopping"))
    clearInterval(this.timer)
    clearInterval(this.scanTimer)
    await this.draining
    await this.runtime.cleanup()
  }
}
