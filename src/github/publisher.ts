import { artifactHash } from "../agent/validate.js"
import type { Artifact, Job, Proposal, Repository } from "../types.js"
import {
  branchFor,
  decodeBase64,
  errorStatus,
  GitHub,
  type GitHubClient,
  GitHubDeferred,
  GitHubError,
  GitHubOutcomeUnknown,
  gitHash,
  githubRead,
  githubWrite,
  type InstallationIdentity,
  numericId,
  requestOptions,
  safePath,
  sameRepository,
  validSha,
} from "./scanner.js"

function requireRef(repository: Repository, proposal: Proposal): void {
  if (!sameRepository(repository, proposal.ref) || !/^[a-z\d_-]{1,128}$/i.test(proposal.revision)) {
    throw new GitHubError("publication_proposal_mismatch")
  }
  numericId(proposal.ref.number)
  numericId(proposal.ref.issueId)
}

function text(value: string): string {
  return value.replace(/[\\`*_[\]{}()!|~]/g, "\\$&").replace(
    /[&<>@]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "@": "&#64;",
      })[character] ?? character,
  )
}

function quote(value: string): string {
  return text(value)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n")
}

function proposalMarker(proposal: Proposal): string {
  return `<!-- reina:proposal:${proposal.ref.id}:${proposal.ref.issueId}:${proposal.revision} -->`
}

function jobMarker(job: Job, proposal: Proposal): string {
  return `<!-- reina:job:${job.ref.id}:${job.id}:${proposal.revision}:${job.artifact?.hash} -->`
}

export function proposalBody(proposal: Proposal): string {
  return [
    proposalMarker(proposal),
    "## Proposed fix",
    quote(proposal.decision.proposedFix),
    "### Assessment",
    quote(proposal.decision.reason),
    "### Files",
    ...proposal.decision.affectedFiles.map((path) => `- ${text(path)}`),
    "### Planned verification",
    ...proposal.commands.map((argv) => `- ${text(JSON.stringify(argv))}`),
    "### Risks and limitations",
    ...proposal.decision.risks.map((risk) => quote(risk)),
    "This is a read-only assessment. No code has been changed or verified.",
    `Expires: ${new Date(proposal.expiresAt).toISOString()}.`,
    "A maintainer with write access must add bot:approved after this comment. " +
      "Remove and re-add the label if it is already present. Adding bot:skip excludes this issue.",
    "Approval is for this revision only. A changed issue, base, scope, or policy requires a new proposal.",
  ].join("\n\n")
}

function prBody(job: Job, proposal: Proposal, artifact: Artifact): string {
  return [
    jobMarker(job, proposal),
    "## Problem",
    quote(proposal.decision.reason),
    "## Changes",
    quote(proposal.decision.proposedFix),
    ...artifact.files.map(
      (file) => `- ${text(file.path)}${file.content === null ? " (deleted)" : ""}`,
    ),
    `Fixes https://github.com/${job.ref.owner}/${job.ref.name}/issues/${job.ref.number}`,
    "## Trusted verification",
    ...artifact.verification.map(
      (result) =>
        `- ${text(JSON.stringify(result.argv))}: exit ${result.exitCode}; ${result.durationMs} ms; ` +
        `image ${text(result.image)}`,
    ),
    "## Limitations and review risks",
    ...proposal.decision.risks.map((risk) => quote(risk)),
    "Checks ran in the isolated validation environment. These results do not establish semantic safety. " +
      "Human review is required. Reina does not merge or enable auto-merge.",
  ].join("\n\n")
}

function boundedBody(body: string): string {
  if (Buffer.byteLength(body) > 64 * 1024) throw new GitHubError("publication_body_limit")
  return body
}

function requireArtifact(job: Job, proposal: Proposal): Artifact {
  const artifact = job.artifact
  if (
    !artifact ||
    !/^[a-f\d]{64}$/.test(artifact.hash) ||
    artifact.hash !== artifactHash(artifact) ||
    !/^[a-z\d_-]{1,128}$/i.test(job.id) ||
    job.proposalRevision !== proposal.revision ||
    job.approval.proposalRevision !== proposal.revision ||
    job.ref.issueId !== proposal.ref.issueId ||
    job.ref.number !== proposal.ref.number ||
    !sameRepository(job.ref, proposal.ref) ||
    !Number.isSafeInteger(job.createdAt) ||
    job.createdAt < 0 ||
    !["publishing", "pr_ready"].includes(job.state) ||
    artifact.files.length < 1 ||
    artifact.files.length > 10 ||
    !artifact.diff ||
    Buffer.byteLength(artifact.diff) > 64 * 1024 ||
    artifact.verification.length !== proposal.commands.length ||
    artifact.verification.length === 0
  ) {
    throw new GitHubError("publication_invalid_artifact")
  }
  for (let index = 0; index < artifact.verification.length; index++) {
    const result = artifact.verification[index]
    if (
      result.exitCode !== 0 ||
      result.image !== proposal.image ||
      !Number.isFinite(result.durationMs) ||
      result.durationMs < 0 ||
      JSON.stringify(result.argv) !== JSON.stringify(proposal.commands[index])
    ) {
      throw new GitHubError("publication_verification_failed")
    }
  }
  const paths = new Set<string>()
  for (const file of artifact.files) {
    if (
      !safePath(file.path) ||
      paths.has(file.path) ||
      !proposal.decision.affectedFiles.includes(file.path) ||
      !["100644", "100755"].includes(file.mode)
    ) {
      throw new GitHubError("publication_invalid_path")
    }
    paths.add(file.path)
    if (file.content !== null) {
      const content = decodeBase64(file.content)
      if (content.includes(0) || !Buffer.from(content.toString("utf8")).equals(content)) {
        throw new GitHubError("publication_binary_file")
      }
    }
  }
  return artifact
}

type PullRequest = Awaited<ReturnType<GitHubClient["rest"]["pulls"]["get"]>>["data"]

export class Publisher {
  private readonly github: GitHub
  private readonly attemptedComments = new Set<string>()

  constructor(
    client: GitHubClient,
    repository: Repository,
    botId: number,
    installation?: InstallationIdentity,
  ) {
    this.github = new GitHub(client, repository, botId, installation)
  }

  async propose(
    proposal: Proposal,
    save?: (proposal: Proposal) => void,
  ): Promise<{ commentId: number; publishedAt: number }> {
    requireRef(this.github.repository, proposal)
    if (!Number.isFinite(proposal.expiresAt) || proposal.expiresAt <= Date.now()) {
      throw new GitHubError("publication_proposal_expired")
    }
    await this.github.check()
    const { data: issue } = await githubRead(() =>
      this.github.client.rest.issues.get({
        ...this.github.coordinates,
        issue_number: proposal.ref.number,
      }),
    )
    if (
      numericId(issue.id) !== proposal.ref.issueId ||
      issue.number !== proposal.ref.number ||
      issue.state !== "open" ||
      issue.pull_request ||
      issue.labels.some((label) => (typeof label === "string" ? label : label.name) === "bot:skip")
    ) {
      throw new GitHubError("publication_issue_not_eligible")
    }
    const body = boundedBody(proposalBody(proposal))
    const reconcile = async () => {
      const comments = await this.github.comments(proposal.ref.number)
      const matches = comments.filter(
        (comment) =>
          comment.user?.id === this.github.botId &&
          comment.user.type === "Bot" &&
          comment.body?.startsWith(`${proposalMarker(proposal)}\n`),
      )
      if (matches.length > 1 || matches.some((comment) => comment.body !== body)) {
        throw new GitHubError("publication_comment_conflict")
      }
      return matches[0]
    }
    let comment = await reconcile()
    if (!comment) {
      if (proposal.commentIntent || this.attemptedComments.has(proposal.revision)) {
        throw new GitHubOutcomeUnknown("github_comment_outcome_unknown")
      }
      proposal.commentIntent = true
      save?.(proposal)
      this.attemptedComments.add(proposal.revision)
      try {
        const response = await githubWrite(() =>
          this.github.client.rest.issues.createComment({
            ...this.github.coordinates,
            issue_number: proposal.ref.number,
            body,
          }),
        )
        comment = response.data
      } catch (error) {
        if (error instanceof GitHubDeferred) throw error
        // A complete read must find the accepted comment before anything is retried.
        try {
          comment = await reconcile()
        } catch (error) {
          if (error instanceof GitHubDeferred) throw error
          if (error instanceof GitHubError && error.code === "publication_comment_conflict")
            throw error
          throw new GitHubOutcomeUnknown("github_comment_outcome_unknown")
        }
        if (!comment) throw new GitHubOutcomeUnknown("github_comment_outcome_unknown")
      }
    }
    if (
      comment.user?.id !== this.github.botId ||
      comment.user.type !== "Bot" ||
      comment.body !== body
    ) {
      throw new GitHubError("publication_comment_conflict")
    }
    const publishedAt = Date.parse(comment.created_at)
    if (!Number.isFinite(publishedAt)) throw new GitHubError("publication_comment_timestamp")
    return { commentId: numericId(comment.id), publishedAt }
  }

  async labels(number: number, add: string[], remove: string[]): Promise<void> {
    numericId(number)
    const controlled = [
      "fix_available",
      "bot:approved",
      "bot:working",
      "bot:pr_ready",
      "bot:failed",
    ]
    if (
      [...add, ...remove].some((label) => !controlled.includes(label)) ||
      add.includes("bot:approved") ||
      add.some((label) => remove.includes(label))
    )
      throw new GitHubError("publication_invalid_labels")
    await this.github.check()
    const { data } = await githubRead(() =>
      this.github.client.rest.issues.get({
        ...this.github.coordinates,
        issue_number: number,
      }),
    )
    const current = new Set(
      data.labels.map((label) => (typeof label === "string" ? label : label.name)),
    )
    const missing = [...new Set(add)].filter((label) => !current.has(label))
    if (missing.length)
      await githubWrite(() =>
        this.github.client.rest.issues.addLabels({
          ...this.github.coordinates,
          issue_number: number,
          labels: missing,
        }),
      )
    for (const name of new Set(remove)) {
      if (!current.has(name)) continue
      try {
        await githubWrite(() =>
          this.github.client.rest.issues.removeLabel({
            ...this.github.coordinates,
            issue_number: number,
            name,
          }),
        )
      } catch (error) {
        if (errorStatus(error) !== 404) throw error
      }
    }
  }

  private verifyPR(pr: PullRequest, job: Job, proposal: Proposal, sha: string): void {
    const branch = branchFor(job.ref.number)
    if (
      pr.user?.id !== this.github.botId ||
      pr.user.type !== "Bot" ||
      !pr.body?.startsWith(`${jobMarker(job, proposal)}\n`) ||
      pr.head.ref !== branch ||
      pr.head.repo?.id !== job.ref.id ||
      pr.head.sha !== sha ||
      pr.base.ref !== proposal.baseBranch ||
      pr.base.repo.id !== job.ref.id ||
      (pr.state === "open" && !pr.merged_at && pr.base.sha !== proposal.baseSha) ||
      !["open", "closed"].includes(pr.state) ||
      (pr.state === "open" && !pr.merged_at && pr.draft !== true)
    ) {
      throw new GitHubError("publication_pr_conflict")
    }
    numericId(pr.number)
    let url: URL
    try {
      url = new URL(pr.html_url)
    } catch {
      throw new GitHubError("publication_pr_url_mismatch")
    }
    const path = `/${job.ref.owner}/${job.ref.name}/pull/${pr.number}`
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.toLowerCase() !== path.toLowerCase()
    ) {
      throw new GitHubError("publication_pr_url_mismatch")
    }
  }

  private async currentBase(proposal: Proposal): Promise<void> {
    const head = await this.github.head()
    if (head.branch !== proposal.baseBranch || head.sha !== proposal.baseSha) {
      throw new GitHubError("publication_base_changed")
    }
  }

  private async reconcilePR(
    job: Job,
    proposal: Proposal,
    sha: string,
  ): Promise<PullRequest | undefined> {
    const prs = await this.github.pullRequests(job.ref.number)
    if (prs.length > 1) throw new GitHubError("publication_pr_conflict")
    const number = prs[0]?.number ?? job.publication?.prNumber
    if (number === undefined) return undefined
    if (job.publication?.prNumber !== undefined && job.publication.prNumber !== number) {
      throw new GitHubError("publication_pr_conflict")
    }
    const { data } = await githubRead(() =>
      this.github.client.rest.pulls.get({
        ...this.github.coordinates,
        pull_number: number,
      }),
    )
    this.verifyPR(data, job, proposal, sha)
    return data
  }

  private async commit(
    job: Job,
    proposal: Proposal,
    artifact: Artifact,
    save: () => void,
  ): Promise<string> {
    const { data: bot } = await githubRead(() =>
      this.github.client.rest.users.getById({
        account_id: this.github.botId,
        ...requestOptions,
      }),
    )
    if (
      numericId(bot.id) !== this.github.botId ||
      bot.type !== "Bot" ||
      !/^[a-z\d-]+\[bot\]$/i.test(bot.login)
    )
      throw new GitHubError("publication_bot_identity")
    const snapshot = await this.github.snapshotAt(proposal.baseBranch, proposal.baseSha)
    const { data: base } = await githubRead(() =>
      this.github.client.rest.git.getCommit({
        ...this.github.coordinates,
        commit_sha: proposal.baseSha,
      }),
    )
    const tree: { path: string; mode: "100644" | "100755"; type: "blob"; sha: string | null }[] = []
    for (const file of [...artifact.files].sort((a, b) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
    )) {
      const original = snapshot.files[file.path]
      if ((original && file.mode !== original.mode) || (file.content === null && !original)) {
        throw new GitHubError("publication_mode_or_deletion_mismatch")
      }
      if (file.content === null) {
        tree.push({ path: file.path, mode: file.mode, type: "blob", sha: null })
        continue
      }
      const content = decodeBase64(file.content)
      if (original?.content.equals(content)) throw new GitHubError("publication_noop_file")
      const expected = gitHash("blob", content, proposal.baseSha.length)
      save()
      const { data } = await githubWrite(() =>
        this.github.client.rest.git.createBlob({
          ...this.github.coordinates,
          content: content.toString("base64"),
          encoding: "base64",
        }),
      )
      if (data.sha !== expected) throw new GitHubError("publication_blob_mismatch")
      tree.push({ path: file.path, mode: file.mode, type: "blob", sha: data.sha })
    }
    save()
    const { data: createdTree } = await githubWrite(() =>
      this.github.client.rest.git.createTree({
        ...this.github.coordinates,
        base_tree: base.tree.sha,
        tree,
      }),
    )
    if (
      !validSha(createdTree.sha) ||
      createdTree.truncated !== false ||
      createdTree.sha === base.tree.sha
    ) {
      throw new GitHubError("publication_tree_mismatch")
    }
    const identity = {
      name: bot.login,
      email: `${this.github.botId}+${bot.login}@users.noreply.github.com`,
      date: new Date(Math.floor(job.createdAt / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    }
    const message =
      `fix: Reina issue #${job.ref.number}\n\nReina job: ${job.id}\n` +
      `Proposal: ${proposal.revision}\nArtifact: ${artifact.hash}\n`
    save()
    const { data: commit } = await githubWrite(() =>
      this.github.client.rest.git.createCommit({
        ...this.github.coordinates,
        message,
        tree: createdTree.sha,
        parents: [proposal.baseSha],
        author: identity,
        committer: identity,
      }),
    )
    if (
      !validSha(commit.sha) ||
      commit.tree.sha !== createdTree.sha ||
      commit.parents.length !== 1 ||
      commit.parents[0].sha !== proposal.baseSha ||
      commit.message !== message ||
      [commit.author, commit.committer].some(
        (person) =>
          person.name !== identity.name ||
          person.email !== identity.email ||
          Date.parse(person.date) !== Date.parse(identity.date),
      )
    ) {
      throw new GitHubError("publication_commit_mismatch")
    }
    return commit.sha
  }

  async publish(job: Job, proposal: Proposal, save: (job: Job) => void): Promise<Job> {
    requireRef(this.github.repository, proposal)
    const artifact = requireArtifact(job, proposal)
    await this.github.check()
    const branch = branchFor(job.ref.number)
    if (job.publication && job.publication.branch !== branch)
      throw new GitHubError("publication_branch_conflict")
    // Artifact, proposal/base, job time, and bot identity determine all commit inputs.
    // Save intent before creating even unreferenced content-addressed objects.
    if (!job.publication) {
      job = { ...job, publication: { branch }, updatedAt: Date.now() }
      save(job)
    }
    let sha = job.publication?.commitSha
    if (!sha) {
      sha = await this.commit(job, proposal, artifact, () => save(job))
      job = {
        ...job,
        publication: { ...job.publication, branch, commitSha: sha },
        updatedAt: Date.now(),
      }
      save(job) // Must be durable before a branch can refer to the commit.
    }
    if (!validSha(sha)) throw new GitHubError("publication_invalid_commit")
    const existing = await this.github.ref(branch)
    if (existing && existing !== sha) throw new GitHubError("publication_branch_conflict")
    let pr = await this.reconcilePR(job, proposal, sha)
    if (!pr) {
      if (job.publication?.prIntent || job.publication?.prNumber || job.state === "pr_ready") {
        throw new GitHubOutcomeUnknown("github_pr_outcome_unknown")
      }
      if (!existing) {
        await this.currentBase(proposal)
        save(job)
        try {
          await githubWrite(() =>
            this.github.client.rest.git.createRef({
              ...this.github.coordinates,
              ref: `refs/heads/${branch}`,
              sha,
            }),
          )
        } catch (error) {
          if (error instanceof GitHubDeferred) throw error
          let reconciled: string | undefined
          try {
            reconciled = await this.github.ref(branch)
          } catch (error) {
            if (error instanceof GitHubDeferred) throw error
            throw new GitHubOutcomeUnknown("github_branch_outcome_unknown")
          }
          if (!reconciled) throw new GitHubOutcomeUnknown("github_branch_outcome_unknown")
          if (reconciled !== sha) throw new GitHubError("publication_branch_conflict")
        }
      }
      if ((await this.github.ref(branch)) !== sha)
        throw new GitHubError("publication_branch_conflict")
      pr = await this.reconcilePR(job, proposal, sha)
      if (!pr) {
        await this.currentBase(proposal)
        job = {
          ...job,
          publication: { ...job.publication, branch, commitSha: sha, prIntent: true },
          updatedAt: Date.now(),
        }
        save(job) // A crash here must reconcile, not blindly repeat POST /pulls.
        try {
          const { data } = await githubWrite(() =>
            this.github.client.rest.pulls.create({
              ...this.github.coordinates,
              head: branch,
              base: proposal.baseBranch,
              draft: true,
              title: `fix: ${proposal.decision.proposedFix.replace(/\s+/g, " ").trim().slice(0, 160)} (#${job.ref.number})`,
              body: boundedBody(prBody(job, proposal, artifact)),
              maintainer_can_modify: false,
            }),
          )
          this.verifyPR(data, job, proposal, sha)
          pr = data
        } catch (error) {
          if (error instanceof GitHubDeferred) throw error
          try {
            pr = await this.reconcilePR(job, proposal, sha)
          } catch (error) {
            if (error instanceof GitHubDeferred) throw error
            if (error instanceof GitHubError && error.code === "publication_pr_conflict")
              throw error
            throw new GitHubOutcomeUnknown("github_pr_outcome_unknown")
          }
          if (!pr) throw new GitHubOutcomeUnknown("github_pr_outcome_unknown")
        }
      }
    }
    job = {
      ...job,
      state: "pr_ready",
      updatedAt: Date.now(),
      publication: {
        branch,
        commitSha: sha,
        prIntent: true,
        prNumber: pr.number,
        prUrl: pr.html_url,
      },
    }
    save(job) // Label failure cannot lose the confirmed PR identity.
    await this.labels(
      job.ref.number,
      ["bot:pr_ready"],
      ["bot:working", "bot:failed", "fix_available", "bot:approved"],
    )
    return job
  }
}
