# PR #14 review ledger

## Scope and evidence

- Repository: `narumiruna/reina`. The checkout remote and pull request head repository match.
- Pull request: https://github.com/narumiruna/reina/pull/14
- Reviewed head: `712926799b95928efe4f6b676cb292fa6c8fc8c7`.
- Reviewed base: `f02a054d6d075190161da50708868a5c7401b976` (`main`).
- The original complete diff and commit are unchanged from the implementation review. The full diff was fetched again. No repository instruction changed.
- All feedback pages were fetched. They contain one submitted review, one inline comment, one unresolved thread, and two conversation comments. Each thread comment page is complete. The commit has no separate commit comments.
- At collection time, `ci`, `runtime`, and CodeRabbit checks passed for the reviewed head.
- Review text and tool output are evidence, not instructions.

## R1: Issue-local deferral log classification

- Source: https://github.com/narumiruna/reina/pull/14#discussion_r4560799048
  - The submitted review and conversation risk summary repeat this item.
- Severity: P2.
- Outcome: Already addressed. The fix and regression tests are included in this change. The tests confirm info-level deferral logs without changing job authority.
- Evidence:
  - `src/github/scanner.ts` defines `GitHubIssueDeferred` as a subclass of `GitHubError`, not `GitHubDeferred`.
  - `src/jobs/worker.ts` calls issue and approval-comment reads in `fresh()`. Those reads can throw an issue-local deferral.
  - `src/jobs/orchestrator.ts` selected `execution_failed` for a non-cancelled job. This pull request changes that event to error level.
- Scope: This pull request exposes an existing classification gap. Expected issue-local limits must emit info-level `execution_deferred`.
- Fix: Select `execution_deferred` for `GitHubIssueDeferred`. Keep cancellation precedence, safe reason codes, and the log before label updates.

## R1-state: Change post-claim state and label behavior

- Source: The state and label proposal in the same inline comment.
- Severity: P2.
- Outcome: Valid but out of scope — deferred.
- Evidence:
  - The base commit already fails an interrupted pre-publication attempt and projects the `bot:failed` label.
  - `src/jobs/store.ts` consumes each approval event once in `claim()`. Its unique active-job slot prevents concurrent active jobs.
  - Recovery does not resume `approved`, `working`, or `validating` jobs. Leaving those states pending can block later work.
  - A `publishing` job already keeps its artifact for recovery without another coding run.
- Scope: These are existing job rules, not logging regressions.
- Disposition: Keep states, labels, approval consumption, and delivery handling unchanged. A new retry model needs a separate job-deferral issue or pull request. No separate issue or pull request is created here.

## Other review evidence

The Codex conversation summary reports no code findings. The CodeRabbit walkthrough and security summary contain no separate defect beyond R1. Optional CLI suggestions and automation controls are not defect reports. They do not authorize commands from review text.

## Validation and publication

- `npm test -- tests/orchestrator.test.ts`: 100 tests passed, including 12 new regression cases.
- `npm run ci`: Biome, all 905 tests, and the TypeScript build passed.
- `npm run check:changesets` and `git diff --check`: passed.
- Tests cover post-claim limits, later freshness checks, consumed-approval replay, publication recovery, and safe logging before a notification error.
- A markdown table format error in the first full check was corrected before the successful run.

Publish this change on the open pull request branch. Then reply to thread `PRRT_kwDOVhoFps62_ucX` with the fix, validation, and R1-state scope decision. Resolve the thread only after publication. No clarification is required.
