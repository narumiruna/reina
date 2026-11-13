# Admin Web UI

Use `https://reina.narumi.dev` to manage the GitHub App private key, providers, saved models, and
selected model preference. See the retained [terminology reference](architecture.md#terminology)
for SDK concepts and Reina records. Bootstrap identity and runtime policy remain in the private
environment file.
The UI can start without GitHub credentials, repository IDs, a model, or a ready worker.
Dispatch stays disabled and webhooks return HTTP 503 until the controller is ready.

## Bootstrap and ingress

Follow [Compose startup](../README.md#run-with-docker-compose-linux). Keep `.env` untracked and
mode `0600`. Keep `REINA_STATE_DIR` private, persistent, and outside the checkout; use mode `0700`
and the service account as owner. Compose stores it in the `reina-state` volume at `/var/lib/reina`.
Only one service instance is supported.

| Variable              | Purpose                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `PUBLIC_URL`          | Public origin; defaults to `https://reina.narumi.dev`. Use HTTPS for deployment.          |
| `PORT`                | Loopback HTTP port; defaults to `36816`.                                                  |
| `ENCRYPTION_KEY`      | Required 64 hexadecimal characters. Generate once with `openssl rand -hex 32`.            |
| `OIDC_ISSUER`         | Pocket ID HTTPS issuer URL for discovery.                                                 |
| `OIDC_CLIENT_ID`      | Confidential OIDC client ID.                                                              |
| `OIDC_CLIENT_SECRET`  | Confidential client secret.                                                               |
| `OIDC_ALLOWED_GROUPS` | Comma-separated exact Pocket ID group **Name** values; case-sensitive. Empty locks login. |

The realm operator must terminate TLS for `reina.narumi.dev` and reverse proxy to
`http://127.0.0.1:36816`. Preserve `Host: reina.narumi.dev`, the request path, and query string.
Reina checks `Host` against `PUBLIC_URL`; an incorrect header returns HTTP 421.
Do not expose the loopback listener directly. Forward the UI, `/auth/*`, `/api/*`, and webhook
requests. Do not log authorization codes, cookies, or request bodies at the proxy.

The Pocket ID account owner must register:

- A confidential client with authorization code flow, PKCE S256, and client-secret authentication
  (`client_secret_post`).
- The exact redirect URI `https://reina.narumi.dev/auth/callback`.
- Scopes `openid profile groups`.
- Approved group **Name** values in `OIDC_ALLOWED_GROUPS`, for example `reina-admins`.

Use a dedicated administrator group. Matching is exact and case-sensitive; membership in any
configured group grants full administration. Do not configure subjects, email addresses, user
names, group UUIDs, or **Friendly Name** values. The schema default is an empty allowlist, which
locks login. Reina does not automatically grant administration to the `user` group.

The official [Pocket ID scopes and claims documentation](https://pocket-id.org/docs/guides/scopes-and-claims)
describes the `groups` scope as an array of group names in both the ID token and userinfo.
These are group **Name** values, not **Friendly Name** values. This page describes unreleased
behavior; it does not prove that the deployed Pocket ID version emits these claims. The client
owner must confirm the deployed signed ID-token claim with OIDC Data Preview before enabling
login. Do not probe public services to discover claims or membership.

## Authorization and sessions

Reina verifies state, nonce, and the signed ID token before checking its `groups` claim. That
claim must be a bounded array of strings and contain an exact configured group name. Missing,
malformed, oversized, or nonmatching claims deny login. Userinfo is not an authorization fallback.
The existing `sub` claim is retained only as session identity, never as administration authority.
The `email` and `name` claims are not authorization inputs.
Login transactions expire after five minutes and can be consumed only once. A missing issuer,
client ID, client secret, or an empty group allowlist locks login. There is no local password or
bypass. Pocket ID account access alone does not authorize Reina administration.

Sessions retain the eight-hour maximum lifetime. `settings.sqlite` stores the login-time groups
and a hash of the session bearer token, not the token itself. Cookies are `Secure`, `HttpOnly`,
and `SameSite=Lax`. Mutations require the exact public origin and a session CSRF token. Every
authenticated request checks configured groups against the session's stored login-time groups.

The authentication-context digest includes the issuer, client ID, public origin, and allowed
group list. Changing any of these invalidates all stored sessions at the next startup. Restart
after bootstrap changes. Logout deletes only the local Reina session; it does not log out of
Pocket ID or revoke the Pocket ID session.

Removing a member from a group in Pocket ID does **not** immediately revoke an existing Reina
session. There is no live membership refresh or back-channel logout. The next login reads membership
again. Sessions expire at most eight hours after login; further access requires a new login.
Restarting with an unchanged authentication context does not refresh stored membership. Preserve
this revocation limit in operational procedures; do not treat Pocket ID membership removal as
instant session revocation.

## Upgrade from subject authorization

Configure `OIDC_ALLOWED_GROUPS` with confirmed group **Name** values before upgrading. Remove the
old subject-based configuration; it is no longer supported. Stop Reina and take a consistent
state backup with the original `ENCRYPTION_KEY` before the upgrade.

The settings migration from schema version 1 adds `sessions.groups` as JSON and deletes legacy
sessions, which have no verified group claim. These administrators must sign in again. This group
migration remains in the upgrade path to settings schema 3; provider account support does not
change Pocket ID group authorization or its eight-hour revocation limit.

## Upgrade to typed provider credentials

Settings schema 3 stores encrypted typed `api_key` and `oauth` credentials, SDK provider identity,
and a logical credential generation. The transactional migration wraps legacy API keys in typed
envelopes and preserves provider entries, models, active selection, the GitHub App PEM, and
schema-2 sessions. Upgrading from schema 1 still removes sessions without verified groups as
described above. Migration or encryption-key failure rolls back the transaction.

Stop Reina and take a consistent pre-upgrade backup of all SQLite state, including WAL state.
Keep the same `ENCRYPTION_KEY`; do not reset the database or regenerate the key. Test migration
and restoration on disposable fixture copies before production. This is the settings schema,
not the separate job database schema. A binary downgrade requires the matching pre-upgrade
backup, not manual removal of OAuth rows or columns. A restored backup can restore old sessions
and credentials: revoke affected sessions and review provider authorization before dispatch.

## Upgrade to durable issue triage

Job database `reina.sqlite` migrates transactionally from schema 4 to 5, adding bounded current
review records and an independent reconciliation cursor. Existing proposals, approvals, jobs,
deliveries, and legacy attempt hashes remain intact; attempt hashes do not become completed
reviews. This is not encrypted `settings.sqlite`, which remains at schema 3. No new UI, settings,
environment variable, or automatic label provisioning is added.

Before upgrade, stop the single instance and back up both databases consistently, including WAL
state, with the original `ENCRYPTION_KEY` retained separately. Test migration and restoration on
disposable fixture copies first. A downgrade needs the matching pre-upgrade application and
backups; never lower schema versions or delete approval/job/review records. A restore can restore
old sessions, credentials, and publication intents but does not undo GitHub comments, labels,
branches, or PRs. Review both restored authority and remote state before enabling dispatch.

Have the App owner create `bot:triaged`, `bot:needs-info`, `bot:needs-human`, and `bot:triage-failed`
in addition to the existing six definitions. See [label meanings](architecture.md#approval-and-state).
Missing definitions can leave publication pending. Do not remove maintainer labels or edit immutable
proposal comments to repair triage. Follow [triage recovery](architecture.md#attempts-and-publication-recovery)
rather than clearing saved results, attempts, or publication intents.

## Onboarding

Obtain authorization for paid provider use and test-repository changes before completing dispatch
configuration. Once all settings are ready, the controller can start scans and process approvals.
A saved setting is not proof of successful remote authentication or provider compatibility.

1. Sign in with a Pocket ID account that belongs to an allowed group.
2. Open **GitHub App** and upload the App's unencrypted RSA private key in PEM format.
   - The key must be at least 2048 bits and no larger than 32 KiB.
   - The UI shows configured status, upload time, and a SHA-256 public-key fingerprint.
   - The saved PEM is never returned. Replacement and deletion are supported.
3. Open **Models**, select **Configure provider**, then use **Select authentication method** to
   choose **Sign in with an account** or **Sign in with an API key**. In **Select provider**, search
   providers for that method and select **Continue**.
   - Built-in providers use SDK-owned prompts, verification links, and device or manual codes.
     Provider-specific login actions use the SDK login label when supplied.
     Reina fixes headless SDK choices on the server; there is no callback-port setting.
   - For Copilot account login, separately confirm the disclosed remote model-policy changes
     before the SDK starts. Only public `github.com` accounts are supported.
   - Use **Back** to change the setup step or **Cancel** to stop pending setup. A cancelled,
     expired, denied, or failed setup does not replace a prior credential or model selection.
   - For a custom endpoint, choose **Sign in with an API key**, then **Add custom provider**.
     Only this path asks for **Display name**, **API**, **Base URL**, and an API key.
     Use public HTTPS without URL credentials, query, or fragment. Private and loopback
     destinations are blocked; DNS is checked at connection time and redirects are rejected.
   - A custom provider can be saved without a key, but its model cannot be selected without one.
     A blank key on edit keeps the saved key. Changing the endpoint requires a new key.
4. Select **Add model** for the provider. Search its catalog models and review the saved limits.
   Built-in entries must use supported SDK models; custom providers can set **Model ID**,
   **Display name**, **Context window (tokens)**, and **Maximum output tokens setting**.
   Select **Save model** to add a record to **Saved models**. Saving a credential or model does
   not select a model.
5. Use **Select model** to store the **Selected model** preference. Only one model can be selected.
   This preference does not prove that a running worker has applied it; inspect runtime status.
   - Requests accept text and tool calls, not image or audio input. The Pi coding agent uses
     thinking level Off (`--thinking off`); this does not promise that provider reasoning is disabled.
     Provider-enforced reasoning and token accounting still require live compatibility checks.
   - Non-Codex SDK output caps are at most 4,096 tokens, or the lower saved limit. Codex does
     not enforce that upstream token cap; see [provider methods and limits](#provider-methods-and-limits).
   - The catalog is static SDK metadata, not a live account entitlement check.
6. Complete the App, repository, policy, and immutable worker settings in the environment file.
   Follow [GitHub App configuration](../README.md#configure-the-github-app) and
   [worker preparation](../README.md#prepare-a-target-worker), then restart for environment changes.
   `APP_ID` and `WEBHOOK_SECRET` remain environment settings. Remove legacy model environment
   variables; `loadConfig` rejects them. Model credentials are managed only in the UI.
7. Select **Refresh status** to inspect runtime status. Use **Apply configuration** to retry after
   fixing an external dependency. This is not a provider connection test.

There is no automatic paid provider connection test. **Subscription configured**, **Account
configured**, **API key configured**, the App's **Key configured** status, and saved model metadata
report local configuration only. They do not verify remote authentication, entitlement, compatibility,
or live acceptance. The [terminology reference](architecture.md#terminology) defines the status rules.

## Provider methods and limits

Reina uses the pinned pi-ai 1.5.0 provider registry and authentication implementations, not an
independent token exchange. Account methods are limited to these headless flows:

| SDK provider     | Account method   | Limit                                                                       |
| ---------------- | ---------------- | --------------------------------------------------------------------------- |
| `openai-codex`   | Device code      | Separate from OpenAI API-key access; see the output-cap limit below.        |
| `anthropic`      | Copy/manual code | Complete the SDK authorization link and manual-code prompt.                 |
| `github-copilot` | Device code      | Public `github.com` only; separate consent before SDK model-policy changes. |
| `kimi-coding`    | Device code      | Requires the provider account's model entitlement.                          |
| `meta`           | Device code      | Requires the provider account's model entitlement.                          |
| `xai`            | Device code      | Requires the provider account's model entitlement.                          |

OpenAI's callback-based ChatGPT account method and OpenRouter account login require local SDK
callback listeners and are not exposed. OpenAI Codex account login is supported through its
separate device-code provider. OpenAI API-key access is not Codex account access. API-key methods
remain available where the SDK's models and protocols fit Reina. Radius uses unsupported
`pi-messages` and is not usable. GitHub Enterprise account login is not supported.

Supported protocols are `openai-completions`, `openai-responses`, `anthropic-messages`,
`google-generative-ai`, and the distinct `openai-codex-responses`. Each built-in model retains
its SDK protocol, endpoint, headers, and compatibility data. No extra callback listener or port,
provider credential storage in the browser, or import of host Pi authentication files is added.
Reina's Pocket ID sign-in grants administration only; it is not provider OAuth authorization.

**Codex output-cap limitation:** SDK 1.5.0 ignores `maxTokens` for Codex and omits
`max_output_tokens`. Reina preserves the supported SDK payload; it must not inject unsupported
wire fields. The saved output limit does not enforce an exact upstream 4,096-token cap for Codex.
Request-count, 1 MiB request-body, 4 MiB response-byte, 60-second request, and job-time budgets
remain. These are not token or billing caps. Other supported SDK adapters apply a 4,096-token
output cap, or the lower saved limit. Before production Codex use, the account owner must
explicitly authorize bounded live acceptance and review output behavior and billing under this
limitation. Credential-free fixtures cannot close this gate.

## Setup ownership and credential management

Setup state is memory-only and bound to the initiating Reina session and an opaque flow ID. A
flow lasts at most 15 minutes; a provider can shorten that deadline. The service holds at most
64 total flows and four active flows per session owner. All setup mutations require exact Origin
and CSRF checks. Another session cannot read, answer, or cancel the flow. Stale prompt responses
are rejected and cannot advance login. Cancel, expiry, owner logout or session invalidation, and
server shutdown stop pending SDK work. Late completions cannot commit a credential.

Login writes are staged, then committed atomically with a credential-generation check. A failure
preserves the prior credential, models, and selection. Successful setup also leaves selection
unchanged. Use **Edit provider**, then **Update credential** or **Remove credential** for a
built-in connection. Updating retains that provider and sign-in method; it is not an implicit
account-method conversion. Separate saved connections to the same SDK provider stay isolated.

Credential replacement changes the logical generation and `modelRevision`, stops affected work,
and requires a fresh proposal and human approval. Normal OAuth token refresh within the same
generation does not change `modelRevision` or approval authority. The host uses SDK `Models.getAuth()`
with serialized credential modification and atomic compare-and-swap persistence. A late refresh
cannot overwrite a replacement credential or restore a deleted one. Failed refresh preserves the
stored credential, stops the request with a safe reconnect error, and never falls back to another
account, API key, provider, or ambient host credential. Model eligibility is checked again after
refresh. Shutdown stops new auth operations and waits for started token rotations to persist before
closing SQLite; cancelling an inference request must not discard a rotated refresh token.

**Remove credential** stops affected work, retains the saved connection and models, and clears
selection if it uses that connection. This removes local authorization; it does not claim
provider-side token revocation and does not log out of Reina or Pocket ID.
Deleting a selected model or provider also clears selection and stops dispatch. Deleting a
provider deletes its models and credential. Deleting the App key disables dispatch.

## Applying settings and failures

Every successful settings mutation requests a controller reload. The controller first disables
webhook dispatch and stops current jobs. It then creates a new immutable runtime configuration
snapshot from the environment and saved selection. Workers cannot change that snapshot.
Schedule configuration changes for a maintenance period; they can cancel current work.

| Runtime state    | Operator action                                                                        |
| ---------------- | -------------------------------------------------------------------------------------- |
| `starting`       | Wait for application, then refresh settings. Webhooks return HTTP 503.                 |
| `not_configured` | Complete the model, App key, or environment settings indicated by the reason.          |
| `running`        | Configuration is applied; still complete authorized external acceptance.               |
| `failed`         | Check the reason, GitHub authentication, and sandbox controls. Do not relax isolation. |

For `cleanup_requires_operator_check`, dispatch is latched stopped. Repeated UI reloads cannot
clear it. Inspect and remove only Reina-owned orphan resources, confirm cleanup, then restart.
Follow [recovery procedures](architecture.md#operator-actions); do not clear job or publication
records to force a retry. Missing runtime controls never enable host execution.

## Secret storage and recovery

The App PEM and typed provider credentials are encrypted with AES-256-GCM in private
`settings.sqlite` next to the job database. OAuth envelopes retain the complete SDK access/refresh
tokens and provider-specific fields. The encryption key comes from `ENCRYPTION_KEY`, not the
database. Settings responses return metadata and credential-presence flags only; setup responses
contain bounded prompts, verification links/user codes, progress, and result metadata, never tokens.
Saved secrets are not read back through the UI or API, stored in browser localStorage or
sessionStorage, or passed to workers, job/proposal records, or logs. Newly entered API keys or
manual codes exist briefly in browser memory for submission; do not put them in chat or proxy logs.

Only the trusted host resolves SDK `ModelAuth`, including header-based authorization and dynamic
Copilot endpoints. Copilot endpoints are restricted to validated public SDK destinations; all
credential-bearing model requests retain public-HTTPS, connection-time DNS, and redirect checks.
SDK login and refresh traffic use a separate, async-context-scoped transport. It permits only fixed
provider HTTPS hosts, methods, and paths, including Copilot model and policy requests derived from
its token. It checks DNS at connection time, rejects redirects and compressed auth responses, and
limits each auth response to 1 MiB, each request body to 64 KiB, and each request to 30 seconds.
API-key-only providers can show local prompts but have no outbound auth routes. Unscoped host
HTTP traffic keeps its original transport.
Workers receive only their bounded socket capability, not upstream credentials or native signed
continuation data. No ambient environment, command, filesystem, or host Pi auth fallback is used.

1. Stop Reina and confirm job cleanup before backup or restoration.
2. Back up all state databases consistently, including their WAL state. Never copy only a live
   main database file. Preserve job, approval, inbox, and publication records with settings.
3. Securely back up the original encryption key separately from the state backup. Restrict access
   to both. Losing that key makes the encrypted App key and provider credentials undecryptable.
4. Restore compatible application state and the original key together. A downgrade after job
   schema 5 or settings schema 3 requires matching pre-upgrade backups. Review restored credentials
   and revoke affected sessions; a backup can restore old authorization. Reconcile GitHub resources,
   including triage comments and labels, before enabling dispatch. A database restore does not undo
   remote writes. Do not delete state to hide an encryption-key mismatch.
5. There is no built-in encryption-key rotation. Do not blindly regenerate `ENCRYPTION_KEY` during
   setup, upgrade, or recovery. Plan any replacement as a controlled credential reconfiguration,
   with backups and dispatch stopped; changing the value alone does not re-encrypt data.

## Operator smoke check and external handoff

```sh
curl --fail http://127.0.0.1:36816/healthz
```

This confirms HTTP readiness only. With owner authorization, check the HTTPS entrypoint, sign-in
for an allowed group member, denied sign-in without a matching group, metadata-only settings
responses, and local logout. Confirm that incomplete configuration returns HTTP 503 for webhooks;
do not submit real unsigned webhook bodies.

The native macOS controller path through OrbStack remains unverified: its baseline stopped at
`runtime_socket_unavailable`. Earlier Linux-container attempts also failed preflight. The issue-triage
verification below subsequently passed the full suite with a Linux controller, private same-path
Linux staging, and the unchanged isolation requirements. This is evidence for that tested topology,
not native macOS or production acceptance. Do not substitute an image build, Compose config, or
browser check for the complete runtime gate on the actual Linux deployment host.

### Previous local verification on 2026-11-13

- `npm run ci`: 837 tests passed; Biome and the TypeScript build passed.
- `npm run check:changesets` and strict standalone type checks for the changed test files passed.
- Actual SDK fixtures cover all six account login/refresh implementations, all six model adapters,
  Copilot policy consent, token rotation races, shutdown persistence, and scoped auth transport.
- HTTPS browser fixtures passed method filtering, prompts, Back/Cancel/Escape, safe links, session
  expiry, mixed model catalogs, custom setup, and 320/390-pixel layouts. A separate integrated
  check used the real admin routes, SQLite, SDK API-key login, and Codex device login/refresh with
  mocked provider responses. It verified no automatic model selection and no credential readback.
- `npm run test:runtime`: the Compose fixture passed. The runtime fixture stopped at
  `runtime_socket_unavailable`, preventing its 12 cases from running. A disposable copy of
  unchanged `HEAD` reproduced the same result. This does not waive the production Linux gate.

No real provider authorization, paid inference, live database migration, deployment, or account
policy change was performed.

### Terminology review handoff

The terminology change described here changed copy, a reused SDK type, and additive read-only
presentation metadata only. Review the [retained glossary](architecture.md#terminology) and the
local HTTPS fixture before/after captures for provider setup, authentication methods, model selection, and mobile
layout. No live provider calls, paid requests, deployment, or state migration are needed for this
wording review. Local checks can verify labels and metadata isolation, not subjective wording
acceptance; the maintainer must confirm that configured, selected, and running states and both
logout boundaries remain clear. The previous verification counts above are not a report for this
terminology change. The owner-operated acceptance and production Linux runtime gates remain open.

- Before captures: `/tmp/reina-terminology-before-method.png`,
  `/tmp/reina-terminology-before-models.png`, and `/tmp/reina-terminology-before-mobile.png`.
- After captures: `/tmp/reina-terminology-after-method.png`,
  `/tmp/reina-terminology-after-models.png`, and `/tmp/reina-terminology-after-mobile.png`.
  Both sets were captured and inspected locally; they contain only fixture data.
- Terminology validation: `npm run ci` passed 846 tests across 19 files, plus Biome and the source
  build. Strict test type checks, changeset validation, and whitespace checks passed.
- Metadata tests verify explicit SDK labels without executing auth handlers or exposing secrets.
  Saved-connection IDs, encrypted rows, model selection/revision, Reina sessions, and settings
  schema 3 remain unchanged by enumeration.
- HTTPS browser checks passed both auth paths, SDK-specific labels, subscription/account and
  missing-metadata fallbacks, credential update/removal, custom setup, model save/selection,
  accessible labels, cancellation, and 320/390-pixel layouts. The integrated check used real
  admin routes and SQLite with mocked provider responses, not live accounts.
- No dependency upgrade, data migration, live provider call, paid request, or deployment was used.
  These checks do not establish subjective wording acceptance or close the existing live gates.

The following work requires external owners and is not established by credential-free tests:

1. **Pocket ID account owner and realm operator:** register the client with `openid profile groups`,
   confirm the deployed signed ID-token group **Name** array with OIDC Data Preview, and supply
   the allowed group names. Configure DNS, TLS, and the Host-preserving proxy. Verify the exact
   callback, allowed and denied login, and the session revocation limit above. Do not probe public
   services or treat unreleased documentation as deployed-version evidence.
2. **Provider account owner:** use an entitled account to verify authorization, MFA where required,
   reconnect, cancellation, and live token rotation. Confirm Copilot policy-change consent before
   starting its flow. Provider availability, subscription policy, and model entitlement remain
   unverified until this owner-operated check. Do not share tokens or authorization codes in chat.
   - Separately authorize bounded paid inference and coordinate a disposable test repository with
     its maintainer. Verify text/tool streaming and continuation, supported output caps, quality,
     and billing. For Codex, explicitly accept the SDK 1.5.0 upstream token-cap limitation above;
     byte/time/request budgets do not establish a 4,096-token cap. No production dispatch is
     accepted from fixtures or a configured credential alone.
3. **Deployment operator:** review the private backup, original encryption key, migration, and
   restore procedure, then run `npm run test:runtime` on the production Linux host. Confirm local
   Docker, cgroup v2, seccomp, quotas, mounts, cleanup, and the upgraded login/refresh path. Keep
   the existing Host-preserving proxy. OrbStack remains unverified; its baseline failures do not
   waive the production Linux release gate.
4. **Repository maintainer:** complete the issue-triage handoff below, inspect the separate fix
   proposal, add a new human approval, and verify one useful draft PR with no auto-merge. Also
   check denied approval, revocation, failure, and restart recovery. Bot-triggered CI must use
   disposable runners with no secrets, write tokens, privileged containers, or deployment access.

### Issue-triage local verification on 2026-11-13

- `npm run ci`: 1,087 tests across 25 files, Biome, and the TypeScript build passed.
  Changeset validation, strict changed-test type checks, and whitespace checks passed.
- `npm run test:runtime`: 14 passed, zero failed, zero skipped. The full suite used actual Pi
  1.5.0, Docker, a local fake provider, and disposable SQLite/Compose resources. It checked
  read-only triage, network denial, quotas, seccomp/cgroups, frozen export, cleanup, credential
  isolation, and host classification of provider 503 versus permanent 401 failures.
- Runtime execution used an ordinary Linux controller with dropped capabilities and
  `no-new-privileges`, an owned Linux volume mounted at the same daemon-visible path, and
  private HOME/Docker config. Node 26.11.1, Docker CLI 29.7.2, Compose 5.5.0, and the OrbStack
  Docker 29.8.2 Linux daemon were tested. No production state or staging was mounted.
- The old nonempty unauthorized readiness request could race a gateway 401 and produce EPIPE.
  The empty-body request passed 20 diagnostic preflights without model calls; the full runtime
  suite still requires 401 and all original sandbox controls. Fixture image tags and staging
  are unique; detached-child fixture file modes are explicit. No check was skipped or weakened.
- The prepared worker-base image ID remained unchanged before and after the run. Test-source
  snapshot SHA-256: `94a11bc2dcd909dc11d6c6295f363f470f1bac340812bd24fa34191fb674c566`.
  Local runtime evidence: `/tmp/reina-runtime-audit-JF2GDa/release-review-runtime.log`.
- Regression fixtures cover strict assessment bounds, UTF-8/escaped-body limits, reserved lifecycle
  metadata, atomic intake/revocation and rollback, restored near-limit records, foreign marker text,
  schema upgrades/rollback, revision CAS, bounded retry/restart, own-comment loops, publication
  response loss, missed closure/skip events, and same-second replacement after revocation.
  Labels never grant approval; mutable summaries never replace immutable proposal evidence.

The first GitHub runtime run passed 13 cases but failed the Compose case: the non-root runner's
`0700` host staging directory was not readable by a root controller with all capabilities dropped.
The fixture now uses its own daemon-owned staging volume and asserts root ownership and `0700`
mode. It removes only that volume; no permission or capability check was relaxed. See the PR's
CI checks for verification of the updated fixture.

These checks used dummy identities and local provider responses. They do not establish live
GitHub permissions/delivery ordering, real provider compatibility or cost, semantic triage quality,
production backup restoration, or production-host runtime acceptance. Complete the handoff below.

### Issue-triage acceptance handoff

This is an owner-operated acceptance procedure, not permission for live writes or paid inference.
Current issue-triage test evidence must be recorded separately from the historical counts above.

1. **App owner and repository maintainer**
   - Prerequisites: authorize disposable issues and bounded provider use; confirm minimum App
     permissions/events, all ten label definitions, and safe target CI.
   - Actions: submit a clear small fix, missing reproduction details, and a product decision.
   - Expected: one mutable summary per issue with kind and host outcome. Needs-info gets
     `bot:needs-info`; a human decision gets `bot:needs-human`. `bot:triaged` follows confirmed
     summary/outcome publication. `fix_available` follows a separate immutable proposal.
     No coding starts without fresh approval of that exact proposal. Then approve and inspect
     one draft PR. Evidence/base/policy changes and 24-hour candidate renewal need new approval.
2. **Repository maintainer and operator**
   - Prerequisites: authorize disposable edit, failure, and restart scenarios; retain saved state.
   - Actions: edit the issue; add/edit/delete a human comment; close or add `bot:skip`; check
     missed-event scans, incomplete/deleted evidence, publication interruption, and restart.
   - Expected: stale-state removal, one updated summary, and no own-comment/label inference loop.
     Closure/skip makes the summary inactive and removes all four triage labels without inference.
     Unavailable/incomplete evidence invalidates the review without claimed successful writes.
     Read recovery preserves the saved model error, attempt count, and retry deadline. A summary
     conflict clears the reviewed claim without editing foreign comments. One trusted, scoped
     triage summary does not consume the ordinary 100-comment/128-KiB evidence budget.
     Publication recovery reuses the saved result. At most three attempts use allowed one-minute/
     five-minute retries; invalid output/isolation failure stops the cycle. Exhausted failures
     remain suppressed after restart or label removal, separate from successful 24-hour renewal.
   - For a same-owner rename, update the configured repository name. Confirm that live numeric
     identity checks permit recovery, the summary is reused, and any replacement proposal needs
     fresh approval. Do not use this path for owner transfers or cross-repository moves.
3. **Provider account owner**
   - Prerequisites: supported entitled account, explicit usage/cost authorization, and acceptance
     of the Codex cap limitation where applicable.
   - Actions: authorize bounded live assessment, including needs-info results; inspect semantic
     quality, tool continuation, output behavior, and billing.
   - Expected: retain actual provider results. Saved credentials and fixtures do not verify
     remote compatibility, entitlement, semantic quality, or cost.
4. **Deployment operator**
   - Prerequisites: stopped-instance backups with WAL state and the original key, disposable
     migration/restore copies, and supported Linux with private same-path staging.
   - Actions: check job schema 4-to-5 migration separately from settings schema 3; test restore,
     permissions, quotas, cleanup, and the complete runtime suite. Reconcile restored GitHub state.
   - Expected: compatible state and confirmed runtime controls before dispatch. Preflight alone
     is insufficient; retain full-suite results and any unverified paths.

Retain verifier, date/revision, authorization scope, prerequisites, actions, observed results, and
unverified paths without private issue text or credentials. Fixtures do not establish live model
quality, App permissions/delivery ordering, provider billing, or production isolation. Record a
blocked path as unverified, not passed. Release requires the required local checks, full runtime
evidence, and owner acceptance, or an explicit authorized exception. The passing Linux-controller
fixture does not establish native macOS/OrbStack or production acceptance; do not weaken isolation
to close an unverified path.

For incident checks, distinguish `triage_started` from `triage_decision` (validated result) and
`triage_completed` (confirmed publication). `triage_stale` invalidates a projection;
`triage_failed` records a safe assessment failure. Use revision, issue identity, and delivery
correlation metadata, not issue bodies, questions, raw model text, or secrets. `bot:triage-failed`
is separate from execution `bot:failed`; label writes can remain pending during GitHub outages.

No live acceptance is claimed. See [architecture and operations](architecture.md) for isolation
limits and publication recovery.
