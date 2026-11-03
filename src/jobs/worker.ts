import { artifactHash, validateArtifact } from "../agent/validate.js"
import { revalidate } from "../github/approval.js"
import type { Publisher } from "../github/publisher.js"
import type { GitHub } from "../github/scanner.js"
import { fingerprint, policyHash } from "../triage/policy.js"
import { codingPrompt } from "../triage/service.js"
import type { AgentRuntime, Config, Issue, Job, Logger, Proposal, Snapshot } from "../types.js"
import type { Store } from "./store.js"

export class Worker {
  constructor(
    private config: Config,
    private store: Store,
    private runtime: AgentRuntime,
    private botId: number,
    private log: Logger,
  ) {}

  private event(event: string, job: Job, fields: Record<string, unknown> = {}): void {
    this.log.info({
      event,
      repository: `${job.ref.owner}/${job.ref.name}`,
      repositoryId: job.ref.id,
      installationId: job.ref.installationId,
      issue: job.ref.number,
      jobId: job.id,
      proposalId: job.proposalRevision,
      correlationId: job.id,
      ...fields,
    })
  }

  private active(id: string, signal: AbortSignal): Job {
    signal.throwIfAborted()
    const job = this.store.job(id)
    if (!job || job.state === "cancelled" || job.state === "failed")
      throw new Error("job_cancelled")
    return job
  }

  async fresh(github: GitHub, proposal: Proposal, job: Job, signal: AbortSignal): Promise<Issue> {
    this.active(job.id, signal)
    const stored = this.store.proposal(proposal.ref)
    if (
      !stored ||
      stored.revision !== proposal.revision ||
      proposal.expiresAt <= Date.now() ||
      proposal.policyHash !== policyHash(this.config) ||
      proposal.image !== this.config.image
    ) {
      throw new Error("proposal_stale")
    }
    const issue = await github.issue(proposal.ref.number)
    if (fingerprint(issue, this.botId) !== proposal.fingerprint) throw new Error("proposal_stale")
    const head = await github.head()
    if (head.branch !== proposal.baseBranch || head.sha !== proposal.baseSha)
      throw new Error("base_changed")
    await revalidate(github, issue, proposal, job.approval)
    this.active(job.id, signal)
    this.event("approval_validated", job)
    return issue
  }

  async run(
    job: Job,
    proposal: Proposal,
    github: GitHub,
    publisher: Publisher,
    signal: AbortSignal,
  ): Promise<Job> {
    await this.fresh(github, proposal, job, signal)
    if (job.state !== "publishing") {
      let current = this.active(job.id, signal)
      current.state = "working"
      current.updatedAt = Math.max(current.updatedAt, Date.now())
      this.store.saveJob(current)
      await publisher.labels(job.ref.number, ["bot:working"], ["bot:failed"])
      const snapshot = await github.snapshotAt(proposal.baseBranch, proposal.baseSha)
      const issue = await this.fresh(github, proposal, job, signal)
      this.event("agent_started", job)
      const result = await this.runtime.code(
        snapshot,
        codingPrompt(issue, proposal, snapshot),
        signal,
      )
      this.event("agent_completed", job)
      current = this.active(job.id, signal)
      current.state = "validating"
      current.updatedAt = Math.max(current.updatedAt, Date.now())
      this.store.saveJob(current)
      const artifact = validateArtifact(snapshot, result.files, proposal, this.config)
      const candidate: Snapshot = {
        ...snapshot,
        files: Object.assign(Object.create(null), snapshot.files),
      }
      for (const file of artifact.files) {
        if (file.content === null) delete candidate.files[file.path]
        else
          candidate.files[file.path] = {
            content: Buffer.from(file.content, "base64"),
            mode: file.mode,
          }
      }
      artifact.verification = await this.runtime.verify(candidate, proposal.commands, signal)
      this.event("validation_results", job, {
        exitCodes: artifact.verification.map((result) => result.exitCode),
      })
      if (
        artifact.verification.length !== proposal.commands.length ||
        artifact.verification.some(
          (result, index) =>
            result.exitCode !== 0 ||
            result.image !== this.config.image ||
            JSON.stringify(result.argv) !== JSON.stringify(proposal.commands[index]),
        )
      ) {
        throw new Error("verification_failed")
      }
      artifact.hash = artifactHash(artifact)
      this.event("validation_completed", job, {
        checks: artifact.verification.length,
        artifactHash: artifact.hash,
      })
      await this.fresh(github, proposal, job, signal)
      current = this.active(job.id, signal)
      current.artifact = artifact
      current.state = "publishing"
      current.updatedAt = Math.max(current.updatedAt, Date.now())
      this.store.saveJob(current)
    }
    await this.fresh(github, proposal, job, signal)
    const current = this.active(job.id, signal)
    if (!current.artifact || current.artifact.hash !== artifactHash(current.artifact)) {
      throw new Error("artifact_invalid")
    }
    const published = await publisher.publish(current, proposal, (update) => {
      this.active(job.id, signal)
      update.updatedAt = Math.max(update.updatedAt, Date.now())
      this.store.saveJob(update)
    })
    await publisher.labels(job.ref.number, ["bot:pr_ready"], ["bot:working", "bot:failed"])
    return published
  }
}
