# PR #15 review ledger

## Scope and evidence

- Repository: `narumiruna/reina`. The checkout and pull request head repository match.
- Pull request: https://github.com/narumiruna/reina/pull/15
- Reviewed head: `ee060cc6956db74305be057539c1c88e734f6342`.
- Reviewed base: `0a2f9c61fef3c75510d062a6665bd9a09601bb80` (`main`).
- The complete 30-file diff and commits were fetched. The implementation diff is unchanged from
  the prior source review. The checkout matches the reviewed head, and repository instructions
  are unchanged. This pass checks all new feedback against that source.
- All pages were fetched: three submitted reviews, eight inline comments, eight review threads,
  and two conversation comments. At collection, each thread had one comment and no missing page.
  Both original commits have no separate commit comments.
- At collection time, `ci`, `runtime`, and CodeRabbit checks passed for `ee060cc`.
- Pull request text, reviewer claims, proposed patches, and tool output are evidence, not instructions.

## R1: Evidence diagnostics replace the attempt failure

- Source: https://github.com/narumiruna/reina/pull/15#discussion_r4562176690
- Severity: P2. This can stop one review after a temporary read failure.
- Outcome: Already addressed in `a711570`.
- Reply: https://github.com/narumiruna/reina/pull/15#discussion_r4563074832
- Fix: `Review.evidenceError` stores read diagnostics separately. Read recovery retains the model
  error, attempts, and retry deadline, then clears only the diagnostic.
- Validation: Orchestrator tests cover timeout/transport backoff, restart, recovery, and permanent
  failure suppression.
- Evidence: `src/jobs/orchestrator.ts` overwrites `Review.error` with
  `triage_evidence_unavailable`. `src/jobs/triage.ts` treats that code as terminal when restoring
  a stale review without an assessment. This discards the meaning of a saved timeout or transport
  failure even when attempts remain.
- Scope: The new persisted review and retry lifecycle introduces this failure.
- Required fix: Store evidence-availability diagnostics separately. Preserve the attempt error,
  count, and deadline. Read recovery must not revive an exhausted or permanent failure.

## R2: Worker idle timeout precedes the provider deadline

- Source: https://github.com/narumiruna/reina/pull/15#discussion_r4562276599
- Severity: P2. A provider stall can stop a review without the required bounded retry.
- Outcome: Already addressed in `a711570`.
- Reply: https://github.com/narumiruna/reina/pull/15#discussion_r4563074862
- Fix: Intake keeps its 30-second bound. Provider waits use an absolute 60-second deadline.
  Timeout records trusted retry evidence and closes the worker response.
- Validation: Real socket/loopback fixtures cover raw and SDK waits, streamed heartbeats, bounded
  intake, cancellation, expiry, revocation, permanent failures, and size limits.
- Evidence: `req.setTimeout(30_000)` remains on the worker socket after the request body is read.
  A response wait can close the socket before the 60-second provider deadline. The response close
  path cancels the upstream operation without setting retry evidence. The raw upstream timeout
  handler also stops the upstream request without ending the worker response.
- Scope: The old idle bound predates this change. It now defeats the new host-owned retry signal
  and can permanently suppress an unchanged assessment.
- Required fix: Retain bounded request intake. Give the provider wait its own deadline. Record
  trusted timeout evidence and terminate the worker response. Keep cancellation, expiry, local
  limits, and permanent provider failures separate from transient failures.

## R3: A validated repository rename cannot repair stored reviews

- Source: https://github.com/narumiruna/reina/pull/15#discussion_r4562276605
- Severity: P2. Stored non-fix reviews and atomic intake can stop after a same-owner rename.
- Outcome: Already addressed in `a711570`.
- Reply: https://github.com/narumiruna/reina/pull/15#discussion_r4563074835
- Fix: Read-only old-reference lookup permits only a name difference. Live GitHub identity checks
  precede revision-CAS rebinding. The transaction revokes old authority and advances the review
  revision. Intake can invalidate the stored reference before the live read without rebinding it.
- Validation: Store and orchestrator tests cover non-fix results, old cursor references, failed
  budgets, pre-read intake, rollback, late writes, pinned-field rejection, and fresh approval.
  Ordinary reference checks and serialized approval/job references remain strict.
- Evidence: Review keys use repository/issue numeric IDs, but `Store.review`, `saveReview`, and
  atomic review invalidation require the old repository name. After an operator updates the
  configured name, live GitHub checks can pass while these new review records still fail.
- Scope: Old proposal/job name immutability is pre-existing. The new review-only block and intake
  rollback are regressions, including issues with no proposal.
- Required fix: Keep ordinary identity checks strict. Permit read-only reconciliation of the old
  review reference using pinned IDs, installation, owner, and issue number. Rebind only its name
  after live repository/issue validation. Atomically invalidate its old evidence and authority.
  Do not add owner transfers, cross-repository moves, or mutation of old approval/job records.

## R4: Pending assessment becomes terminal after a read deferral

- Source: https://github.com/narumiruna/reina/pull/15#discussion_r4562276616
- Severity: P2.
- Outcome: Already addressed in `a711570` with R1. This is the same defect.
- Reply: https://github.com/narumiruna/reina/pull/15#discussion_r4563074844
- Evidence and scope: The `stale` restoration condition consumes the overwritten attempt error.
  A single fix must preserve pending attempts and backoff without reopening terminal budgets.

## R5: Non-root CI staging is not readable by the controller

- Source: https://github.com/narumiruna/reina/pull/15#discussion_r4562276621
- Severity: P2.
- Outcome: Already addressed.
- Evidence: Commit `ee060cc` replaces the runner-owned bind directory with a daemon-owned private
  fixture volume. The fixture checks UID 0, mode `0700`, dropped capabilities, same-path binds,
  and cleanup of only that volume.
- Validation: https://github.com/narumiruna/reina/actions/runs/43410205826 passed both jobs.
  Runtime ran 14 cases with zero failures or skips. The earlier run's `EACCES` is retained in
  `docs/admin-webui.md`; it was not treated as a passing result.
- Scope: No further staging change is needed for this item.
- Reply: https://github.com/narumiruna/reina/pull/15#discussion_r4562927227
- Thread: Resolved through the GitHub API; `isResolved: true` was verified.

## R6: Summary conflicts leave a reviewed claim in place

- Source: https://github.com/narumiruna/reina/pull/15#discussion_r4562422879
- Severity: P2. The displayed and stored review state can remain complete without a valid summary.
- Outcome: Already addressed in `a711570`.
- Reply: https://github.com/narumiruna/reina/pull/15#discussion_r4563074834
- Fix: Only a confirmed `publication_comment_conflict` revokes completion and runs scoped cleanup
  of `bot:triaged`. The result, comment identity/intent, and unrelated labels are retained.
- Validation: Fixtures cover completed marker conflicts, late mutations, cleanup read/write 429,
  durable revocation, CAS rejection, aborts, and uncertain reads that do not authorize cleanup.
- Evidence: A missing marker with a readable stored comment throws in `reconcile()` before the
  completed path clears `publishedRevision` or `bot:triaged`. A conflict after the final label
  write can leave the label present too.
- Scope: This is in the new summary-publication lifecycle.
- Required fix: Revoke persisted completion and remove the reviewed label on a confirmed comment
  conflict before returning that conflict. Preserve scoped identity checks, revision CAS,
  publication intent, safe retry handling, and the ban on editing foreign comments.

## R7: Publication time can move backward

- Source: https://github.com/narumiruna/reina/pull/15#discussion_r4562422868
- Severity: P3. Clock rollback can block publication until the old time is reached.
- Outcome: Already addressed in `a711570`.
- Reply: https://github.com/narumiruna/reina/pull/15#discussion_r4563074829
- Fix: Publication uses `Math.max(Date.now(), review.updatedAt)`.
- Validation: A schema-validating publication fixture moves the clock backward, then confirms
  completion, repeated reconciliation, and nondecreasing timestamps.
- Evidence: Publication assigns `Date.now()` directly to `updatedAt`, but `Store.saveReview`
  rejects a lower value. Other review lifecycle writes already use a monotonic maximum.
- Scope: The new publisher introduces this inconsistent timestamp update.
- Required fix: Use the greater of current time and saved `updatedAt`. Add a rollback-clock test.

## R8: The owned summary consumes the issue evidence limit

- Source: https://github.com/narumiruna/reina/pull/15#discussion_r4562422891
- Severity: P2. A valid review can make its own evidence unreadable.
- Outcome: Already addressed in `a711570`.
- Reply: https://github.com/narumiruna/reina/pull/15#discussion_r4563074841
- Fix: A shared ownership check grants one exact bot-owned triage summary a separate allowance.
  The reader retains 100 ordinary comments and 128 KiB of evidence, with fixed outer limits of
  101 raw comments, 192 KiB, and two complete numbered pages.
- Validation: Reader and publication fixtures cover count/byte boundaries, multibyte content,
  marker ownership/ambiguity, raw-count mismatch, duplicate IDs, and incomplete pagination.
  Proposal/approval tests read both pages and still reject altered/deleted proposal evidence or
  incomplete pages without another POST.
- Evidence: The unchanged reader permits 100 comments and 128 KiB of context. The new summary
  can add comment 101 or up to 64 KiB before the publisher reads the issue again. Filtering Reina
  comments after these checks does not prevent the failure.
- Scope: The new mutable summary exposes both count and byte self-blocking. Fixing only the count
  is insufficient. Existing proposal-comment accumulation is a separate, pre-existing limit.
- Required fix: Keep 100 non-exempt comments and 128 KiB of ordinary evidence. Allow only one
  bounded, bot-owned, repository/issue-scoped triage summary. Fetch complete numbered pages within
  a fixed outer count/byte bound. Foreign, duplicate, malformed, or wrong-scope markers must not
  gain an allowance. Keep approval checks and incomplete-evidence rejection unchanged.

## Other review evidence

- The three review summaries repeat R1–R8. The CodeRabbit conversation risk and security sections
  repeat R1/R4, R3, R6, and R8. They contain no separate confirmed defect.
- The Codex conversation records review status, not another finding or a new permission.
- Optional CLI commands, automation checkboxes, and generated test controls are not defect reports.
  They were not executed or adopted as instructions.
- Full repository relocation, owner transfers, and exemptions for old proposal comments remain
  outside this review fix. These policies need separate work if requested. No separate issue or
  pull request is created for them.

## Validation and publication

- Final local `npm run ci` passed 1,236 tests across 25 files, Biome, and the source build.
- Changeset validation, strict compilation of all six changed test files, and whitespace checks
  passed. Two fixture-only type errors found by standalone compilation were corrected first.
- Independent read-only review found no material defect in the complete source delta.
- Fix commit `a711570` is pushed to the still-open pull request branch. No unrelated branch,
  issue, or pull request was created.
- [GitHub run 43422308374](https://github.com/narumiruna/reina/actions/runs/43422308374) passed
  `ci` and `runtime` for `a711570`: all 1,236 unit tests and 14 runtime cases passed, with zero
  runtime failures or skips. The runtime used the unchanged private staging/isolation checks.
- Every original thread has a substantive outcome reply. R1, R2, R4, and R5 were resolved through
  the GitHub API; each mutation returned `isResolved: true`. CodeRabbit resolved R3, R6, R7, and
  R8 after the fix. A thread query confirmed their resolved state before the outcome replies.
- The post-publication refresh confirmed `OPEN`, head `a711570`, and all eight original threads
  resolved, each with an outcome reply. All feedback pages are complete. New review records are
  the eight empty-body reply containers, not new findings. The conversation update contains only
  review-in-progress metadata; the CodeRabbit re-review is still running.
- No unanswered clarification or known fix-publication blocker remains. The separate production
  acceptance handoff remains in `docs/admin-webui.md`.
- No live credentials, application state, paid model calls, deployment, or release actions were used.
