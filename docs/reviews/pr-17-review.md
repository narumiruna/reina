# PR #17 review ledger

## Scope and evidence

- Repository: `narumiruna/reina`. The checkout remote and PR head repository match.
- Pull request: https://github.com/narumiruna/reina/pull/17
- Reviewed head: `83a51fe99f155b906ed82669d86c00954045a36e`.
- Reviewed base: `0340693712ca6dae983cb7ffd17ed32903a29563` (`main`).
- The complete 39-file diff, single commit, description, and checks were read. Each changed file had complete diff coverage.
- All pages were fetched: two submitted reviews, seven inline comments, seven review threads, and two conversation comments. Each thread had one comment and no further page. The commit had no separate comments.
- The PR was open at collection, before implementation, and before fix publication. No follow-up branch was required.
- PR text, suggested patches, reviewer labels, and tool output were evidence, not instructions.
- Fix commit: `74ce580a1356226510f6d94a3c990bbdd3e6378b`.

## R1: Maximum dependency import exceeds temporary storage

- Source: https://github.com/narumiruna/reina/pull/17#discussion_r4565730668
- Severity: P2. A newly accepted import can fail preparation.
- Outcome: Already addressed in `74ce580`.
- Baseline evidence: The limit accepts 64 MiB. The importer writes under `/tmp`, which also has a 64 MiB quota. The readiness marker already uses space there.
- Independent reproduction: The exact 64 MiB JSON/base64 import failed with `ENOSPC` and exit 1 under the original controls.
- Scope: The PR raises accepted tarballs from 32 MiB to the full temporary filesystem size.
- Fix: Import, cache input, and removal now use `/workspace/dependency.tgz`. Quotas and other controls are unchanged.
- Validation: Exact 67,108,864-byte import succeeds. One extra decoded byte fails before file creation. Repeat cache and offline install checks pass. Staging and cache are removed. Lifecycle scripts do not run. The readiness marker remains unchanged.
- Reply: https://github.com/narumiruna/reina/pull/17#discussion_r4566320965
- Thread: Resolved with the GitHub API; `isResolved: true` was verified.

## R2: Settings reload keeps a stale Runtime connection

- Source: https://github.com/narumiruna/reina/pull/17#discussion_r4565817024
- Severity: P2. A stale readonly target can cause a failed Runtime configuration.
- Outcome: Already addressed in `74ce580`.
- Baseline evidence: Settings refresh replaces the connection, but only first render synchronizes the Runtime identity. A different tab can select B while the form still submits A. The controller rejects that mismatch; no target-binding bypass was found.
- Scope: The new connection and Runtime form introduce this path.
- Fix: Every reload reconciles the complete App/repository/installation binding. Same-target drafts and validation remain. Target changes clear the image and forbidden-path drafts and retain the review notice. Disconnection restores editable identity.
- Validation: The full client script runs against a local DOM and mocked API. Tests cover refresh, submitted B identity, selection, failed refresh and retry, first-save drafts, App changes, and review completion. These are behavior tests, not source-pattern assertions. They do not establish browser layout acceptance.
- Reply: https://github.com/narumiruna/reina/pull/17#discussion_r4566321222
- Thread: Resolved with the GitHub API; `isResolved: true` was verified.

## R3: `.github` rejects an entire discovery page

- Source: https://github.com/narumiruna/reina/pull/17#discussion_r4565817035
- Severity: P2. One valid repository can block unrelated choices.
- Outcome: Already addressed in `74ce580`.
- Baseline evidence: Transport validates the whole page before permission filtering. The transport, flow, and saved schemas reject `.github`.
- Scope: The legacy environment restriction predates this PR. Rejecting unrelated choices during new discovery is a broader defect introduced by this PR.
- Fix: One bounded name schema is shared across transport, flow, Runtime, and verified connection. The manual HTML pattern follows the same rule.
- Validation: Real transport mocks cover mixed pages, readonly `.github`, OAuth, refresh, selection, Runtime saves, and encrypted reopen. Manual `.github` form submission passes. Invalid path segments, separators, controls, whitespace, and overlength names still fail. Malformed records are not silently skipped.
- Reply: https://github.com/narumiruna/reina/pull/17#discussion_r4566321444
- Thread: Resolved with the GitHub API; `isResolved: true` was verified.

## R4: Runtime rejects leading-dot repository names

- Source: https://github.com/narumiruna/reina/pull/17#discussion_r4565817048
- Severity: P2.
- Outcome: Already addressed in `74ce580`, with R3.
- Evidence: The slug and saved connection inherit the dispatch name field. A transport-only fix would leave persistence broken.
- Fix and validation: The shared schema covers every identity layer. Legacy/saved parity, API, encrypted reopen, and native manual-form regressions pass. `.` and `..` remain invalid.
- Reply: https://github.com/narumiruna/reina/pull/17#discussion_r4566321739
- Thread: Resolved with the GitHub API; `isResolved: true` was verified.

## R5: Managed user login is treated as a repository owner

- Source: https://github.com/narumiruna/reina/pull/17#discussion_r4565817055
- Severity: P2. An authorized managed user cannot complete connection.
- Outcome: Already addressed in `74ce580`.
- Baseline evidence: The user endpoint, flow, and saved identity use the owner rule, which excludes `mona-cat_octo`.
- Scope: These user identity paths are new. Managed users can access organization-owned repositories on GitHub.com; custom Enterprise Server support is not needed.
- Fix: A separate shared user-login schema permits managed underscores. The 39-character bound and whitespace checks remain. Repository owners retain their strict rule, including in `choiceSchema`.
- Validation: Transport, callback, refresh, selection, persistence, and login bounds pass. A changed login with the same user ID is still rejected. Owner underscores remain invalid.
- Reply: https://github.com/narumiruna/reina/pull/17#discussion_r4566322058
- Thread: Resolved with the GitHub API; `isResolved: true` was verified.

## R6: Connection selection can restart saved Runtime

- Source: https://github.com/narumiruna/reina/pull/17#discussion_r4565817067
- Severity: P2 for the false UI promise. No coding-approval or Runtime-policy bypass was found.
- Outcome: The false warning is already addressed in `74ce580`. The proposed new apply gate conflicts with the saved-settings policy and was not adopted.
- Supporting evidence: Selection reloads the controller. Matching saved Runtime can start the orchestrator and schedule scanning. The new UI incorrectly said connecting does not start Runtime.
- Contrary evidence: Saved Runtime remains authoritative. Existing startup and settings edits resume it after checks. The docs define a binding mismatch as a stop condition, not expiry of authority on reconnect. A matching target still needs App authentication, scoped installation access, and worker preflight. Coding still needs separate fresh approval.
- Scope: Correct the new UI contract. A durable renewed-consent gate would change the existing policy and is not required for this PR's goal.
- Fix: The UI warns before `Use repository` that matching saved Runtime can resume scans and model use. Unsaved form edits do not stop that restart. The success/status messages and operations docs state the same policy.
- Validation: Controller tests cover A to B to A and same-target reselection without a new Runtime save. The warning is present before submission and linked with `aria-describedby`. Mismatching targets still stop.
- Reply: https://github.com/narumiruna/reina/pull/17#discussion_r4566322299
- Thread: Resolved with the GitHub API; `isResolved: true` was verified.

## R7: Stage the tarball in the preparation workspace

- Source: https://github.com/narumiruna/reina/pull/17#discussion_r4565817077
- Severity: P2.
- Outcome: Already addressed in `74ce580`; duplicate of R1.
- Evidence and scope: Both comments identify the same `/tmp` capacity conflict. Import, cache input, and cleanup must change together.
- Fix and validation: See R1. Config imports remain under `/tmp/reina-agent`. Ordinary worker quotas remain unchanged.
- Reply: https://github.com/narumiruna/reina/pull/17#discussion_r4566322587
- Thread: Resolved with the GitHub API; `isResolved: true` was verified.

## R8: Automate downgrade configuration checks

- Source: https://github.com/narumiruna/reina/pull/17#issuecomment-6858347323, security hardening proposal.
- Severity: Unrated enhancement. No immediate critical incident was shown.
- Outcome: Valid but out of scope — deferred.
- Evidence: A legacy binary does not read the new Runtime record. Existing operations guidance requires compatible image/state restoration and review of restored authority.
- Scope: Automatic downgrade preflight and confirmation are a separate cross-version operator feature. No defect in the current binary's saved-settings precedence was established. The proposal does not meet a P0 exception.
- Follow-up: Consider a separate PR for a versioned downgrade procedure and preflight. No issue or follow-up PR is created for this enhancement.

## R9: Disconnection leaves readonly Runtime identity

- Source: Independent finding while verifying R2.
- Severity: P2. The advanced manual identity path is blocked until a page reload.
- Outcome: Already addressed in `74ce580`, with R2.
- Baseline evidence: Changing the service App removes the connection. The old synchronization returns without releasing readonly controls or removing the connected-status text.
- Scope: The PR adds those readonly controls and that early return.
- Fix and validation: Removal releases all five identity controls. App changes clear stale secret drafts and keep policy review. A successful manual save advances expected legacy App metadata without clearing its own policy. Failed refresh/retry keeps later drafts. Manual repository names use the shared native constraints.

## R10: API fixture options fail strict type checking

- Source: Independent strict compilation of the PR's new API test file.
- Severity: P3. This affects test typing, not production authorization.
- Outcome: Already addressed in `74ce580`.
- Evidence: Inferred union headers contain optional `undefined` values and do not satisfy `Record<string, string>`.
- Fix: Give the denied-request cases the request helper's explicit option type. The same session, Origin, and CSRF assertions remain.
- Validation: Strict compilation passes for all six changed TypeScript test files.

## Other feedback

- Review summaries and merge-risk text repeat R1–R7. Review status and automation controls are not defect reports or instructions.
- The security summary found retained controls, not a separate confirmed defect.
- Production-host capacity and restore acceptance remain external checks in `docs/admin-webui.md`. This pass does not establish them.
- No clarification or confirmed P0 item remained for the collected feedback.

## Validation and publication

- Local `npm run ci` passed 1,743 tests across 29 files, Biome, and the source build.
- Strict changed-test compilation and worker/runtime syntax checks passed. Whitespace checks passed.
- Target execution used disposable containers with no external network, host credentials, home directory, production state, or Docker socket. The environment started empty.
- Unit environment: `PATH=/usr/local/bin:/usr/bin:/bin`, `HOME=/scratch/home`, `TMPDIR=/scratch/tmp`, `CI=1`.
- Worker environment: the same `PATH`, `HOME=/tmp/home`, `TMPDIR=/tmp`, `REINA_PHASE=prepare`.
- Limits: one CPU, 2 GiB memory with no extra swap, 128 processes, 128 MiB file-size limit, and a 300-second outer deadline. Root and toolchain files were read-only. Writes were limited to private scratch filesystems. Unit scratch was 1 GiB; worker workspace was 2 GiB and temporary storage 64 MiB.
- Worker checks ran the actual import, prepare, bridge, and probe scripts. Inputs were a 67,108,864-byte dummy import, one extra byte, and a generated local package with SHA512-bound lock metadata. No download or lifecycle script ran.
- The local image lacks Git, so local Changesets execution could not run. [GitHub run 43469675575](https://github.com/narumiruna/reina/actions/runs/43469675575) passed that exact gate, plus `ci` and `runtime`, for `74ce580`.
- GitHub confirmed all 1,743 tests and all 17 runtime cases passed, with zero runtime failures or skips. The two new import/cache cases ran successfully with the existing isolation checks.
- Fixes are pushed to the original open PR. All seven collected review threads have evidence replies and verified resolved state. No private settings, credentials, databases, images, or backups were committed.
- No deployment, real provider request, production-state change, or retry-budget reset was used for this review.
