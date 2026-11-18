# Admin Web UI

Use `https://reina.narumi.dev` to manage runtime policy, GitHub App settings, providers, saved models,
and the selected model preference. See the retained [terminology reference](architecture.md#terminology)
for SDK concepts and Reina records. Only encryption, login, listener, and persistent storage
bootstrap settings remain in the private environment file.
The UI can start without GitHub credentials, repository IDs, a model, or a ready worker.
Dispatch stays disabled and webhooks return HTTP 503 until the controller is ready.

## Interface language

The login and admin pages support **English** (`en`) and **正體中文** (`tw`). Use the
**Language / 語言** selector to switch without reloading the page or discarding unsaved form input.
Choose a language before you open a dialog. Native modal dialogs block the page language selector.
The preference is stored in this browser under the local storage key `reina.locale`; it is not
an account or server setting. If storage is blocked, switching still works for the current page.

On the first visit, Reina uses the first supported browser language preference: English maps to
`en`, and Chinese (`zh` and its variants) maps to `tw`. Other languages fall back to English.
The page language and locale-sensitive dates and counts use `en` or `zh-Hant`; `tw` is the
application locale ID, not an HTML language tag. i18next uses `en` and `zh-Hant` internally.
The default and fallback catalog is `public/locales/en.json`; Traditional Chinese uses
`public/locales/tw.json`. A missing translation falls back to English. An unknown key is returned
unchanged; English sentences are not translation keys.

Names, repository identifiers, API protocols, secrets, and upstream provider prompts are not
translated. Browser-native validation and file-picker text follow the browser language.
GitHub publications, server logs, and documentation remain in English.

Store translations as plain JSON data, not executable JavaScript modules.
Use stable semantic kebab-case keys, such as `models-title`, in both catalogs. Do not rename a
key when only its wording changes. The catalogs must have the same keys. Use i18next interpolation,
such as `{{name}}`. Pass a numeric `count` for plural messages. The configured plural separator
is `-`, so plural keys also use kebab-case: `provider-saved-model-count-one` and
`provider-saved-model-count-other`. i18next selects the form for each language.

Mark static text with `data-i18n="models-title"`. The binding updates its first non-empty direct
text node and keeps child elements intact. Keep complete sentences in one message instead of
splitting them around markup. Use explicit attribute keys, such as
`data-i18n-placeholder="provider-search-placeholder"`.
For dynamic text, use `setText(element, message("model-delete-confirmation", { name }))`.
Use `raw()` for literal output, including user names, IDs, and upstream prompts.
Use a callback for text that reads a translated label or validation message. On a language change,
source bindings update before text callbacks, so announcements do not keep text from the old language.
Correcting or resetting a field clears its validation announcement, but not a newer request result.
Do not translate form values or render translations as HTML. The credential-free tests check
catalog coverage, matching placeholders, plural forms, locale persistence, and switching with drafts intact.

`npm run build:web` uses esbuild to bundle i18next, the catalogs, and the DOM bindings into
`dist/browser/i18n.js`. The server serves this bundle at `/assets/i18n.js`; no CDN, remote translation
service, or inline import map is used. i18next and esbuild are build-time dependencies; the production
image needs only the generated bundle, not these packages or the TypeScript compiler.
`npm run build` includes this step, and Vitest global setup
runs it before tests. After changing the catalogs or `public/i18n.js`, rebuild before starting
the local server. The Docker build includes the browser sources and build script.

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

Job database `reina.sqlite` schema 7 retains review records, reconciliation cursors, and existing
coding request receipts. The transactional migration adds permanent initial-triage markers,
read-only admissions, one-use label-cleanup intents, and admission baselines. Existing attempts
and ambiguous zero-attempt legacy reviews cannot regain automatic eligibility. Interrupted or
scheduled inference does not retry; saved results and publication recovery remain available.
Unknown pre-upgrade issue history requires a fresh human request, rather than an automatic repeat.
Authoritative creation time after the upgrade cutoff permits initial assessment of new issues.
Fresh databases have no legacy automatic cutoff. Pre-existing labels do not become requests.
Existing claimed approvals, publication records, request epochs, and legacy attempt hashes remain;
hashes do not become completed reviews. This is not encrypted `settings.sqlite`, which remains at
schema 3. No new UI, setting, environment variable, or automatic label provisioning is added.

Before upgrade, stop the single instance and back up both databases consistently, including WAL
state, with the original `ENCRYPTION_KEY` retained separately. Test migration and restoration on
disposable fixture copies first. A downgrade needs the matching pre-upgrade application and
backups; never lower schema versions or delete approval/job/review records. A restore can restore
old sessions, credentials, and publication intents but does not undo GitHub comments, labels,
branches, or PRs. Review both restored authority and remote state before enabling dispatch.

After reviewed code is deployed, have the App owner create `bot:retriage` alongside the existing
ten definitions. A human with current write, maintain, or admin permission adds it to request one
read-only reassessment. Admission is persisted before the bot removes the trigger; inference is
claimed at most once. Failed, timed-out, or interrupted assessments require another fresh request.
If cleanup is uncertain or races another transition, the maintainer may need to remove and re-add
the label. Label presence on scans is not authority; the bot never adds this trigger itself.
It does not authorize coding or a PR. A durable per-issue cutoff rejects older coding requests,
including ones delivered later. A subsequent direct coding request must be created strictly after
that retriage transition; same-second ordering fails closed. A later coding attempt needs fresh
valid coding authority.
See [label meanings](architecture.md#approval-and-state). Missing definitions can leave publication
pending. Do not remove maintainer labels or edit immutable proposal comments to repair triage.
Follow [triage recovery](architecture.md#attempts-and-publication-recovery) rather than clearing
saved results, attempts, admissions, or publication intents.

## Connect GitHub

Use **GitHub App → Connect GitHub** to authorize the existing service App on GitHub. Reina reuses
installations that the signed-in GitHub user can access. Choose a repository and select **Use
repository**; the server verifies access again and records its owner, name, repository ID, and
installation ID. Users do not enter these IDs, upload an App key, or create another App.

If the App needs access to another repository, use **Install or manage App**. GitHub's official
installation page returns through the Setup URL. A forged callback `installation_id` is not
sufficient: Reina verifies both App ownership and the GitHub user's installation/repository access.
Pending organization installation requests do not create a verified connection.

The flow uses same-tab navigation, one-use state bound to the active Pocket ID session, and
OAuth PKCE S256. The GitHub user token remains in bounded server memory during selection and is
never returned to the browser or stored in SQLite. Completion, cancellation, expiry, logout,
service shutdown, or stale App/key settings invalidate the flow. Local token discard does not
claim provider-side revocation. GitHub user authorization is separate from both Pocket ID login
and model-provider authentication.

Connection metadata does not establish worker readiness or grant approval. Selecting a repository
reloads the controller. If it matches a complete saved Runtime configuration, readiness checks can
pass and scans can resume, including model use. Saved Runtime authority remains valid on reconnect;
selection does not grant new coding approval.

A different selected repository stops dispatch until the Runtime binding matches. Review its worker
and policy before applying. The UI clears the previous target's image and forbidden-path draft when
the connection identity changes, including changes from another tab. Ordinary status refresh keeps
same-target drafts and validation errors. If the connection is removed, advanced identity controls
become editable again.

### One-time service operator setup

The service operator opens **GitHub App → Service operator setup**, uploads the existing App RSA
PEM, and saves the App ID, OAuth client secret, and webhook secret. The server authenticates as
the App to discover its client ID and slug. Only presence flags are returned for secrets. Omitted
secrets retain matching App settings; a matching legacy webhook secret can be imported on the
first save. Changing App identity does not reuse the previous App's secrets or verified connection.
Saving a client secret does not prove that GitHub has accepted it; the OAuth callback does that.
Client-secret input removes accidental surrounding whitespace before validation. Empty values and
embedded control characters are rejected. Webhook-secret whitespace is not changed because it must
match GitHub exactly. Before setup is complete, **Connect GitHub** opens the setup section and
focuses its first missing field instead of remaining disabled.

Register the exact URLs shown in the form with the existing GitHub App:

- **User authorization callback URL:** `https://reina.narumi.dev/auth/github/callback`.
- **Setup URL:** `https://reina.narumi.dev/auth/github/setup`.
- Enable **Redirect on update**, so installation repository changes return to Reina.
- Leave **Request user authorization (OAuth) during installation** disabled. Reina explicitly
  starts OAuth with its callback, state, and PKCE challenge before installation.

Use the UI's URLs when `PUBLIC_URL` differs. The GitHub App owner must perform registration,
client-secret creation, MFA, and consent on GitHub. Do not put secrets in chat, URLs, or proxy logs.
The service App settings and verified connection use the existing encrypted secrets table;
settings schema 3 and existing model credentials remain unchanged. Legacy dispatch settings are
not automatically deleted or used to override saved App settings.

GitHub's [setup URL documentation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
explains the untrusted installation ID. The [user-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
defines the OAuth client secret, PKCE, and user installation access checks.

### GitHub connection verification on 2026-11-13

- `npm run ci`: 1,482 credential-free tests passed, including App/connection storage,
  controller binding, fixed-host transport, PKCE/state, callback replay/ownership, cancellation,
  credential rewrite/ABA, and late-completion checks. Build, Biome, Changesets, and whitespace
  checks passed.
- A real HTTPS/SQLite/administrative API browser fixture passed at 320, 390, and 1440 pixels.
  GitHub authorization/installation pages and transport were isolated fixtures, not live accounts.
  The fixture verified one-time legacy webhook migration, existing installation reuse, OAuth and
  Setup callbacks, repository selection without typed IDs, live access refresh, secret redaction,
  Runtime identity inheritance, different-target policy separation, draft preservation, and cancel.
- Thirty-four separate mock-browser scenarios covered strict CSP/Trusted Types, origin validation
  with and without the Origin API, malformed navigation targets, pending-action serialization,
  callback errors, missing/expired installations, and one-time operator setup.
- The Compose fixture passed. All 13 runtime cases passed in the new controller image on the
  Linux daemon with private identical-path staging and a local model protocol fixture. The
  macOS-host Unix-socket limitation remains. The target's initial Biome blocker used the older
  preparation limits; the owner subsequently authorized the capacity increase described below.
- Source review identified cached-only repository refresh. Explicit **Refresh repositories** now
  performs a CSRF-protected POST and rechecks live user access; lazy view/status GETs remain local
  and do not make GitHub requests. Revoked choices cannot be selected from the old cache.

At that initial deployment, the management image was healthy. Existing model credentials,
selected model, App PEM, settings schema 3, and job schema 5 were preserved. Public connection
APIs denied anonymous requests with HTTP 401, unauthenticated callbacks redirected to login,
and incomplete dispatch returned HTTP 503. No coding job, review, or live provider request was
created during that deployment check.
The pre-deployment private backup is
`/Users/narumi/.local/state/reina/backups/20261113T144706Z-github-connect`; it includes both database
backups, the private environment, and the previous immutable controller image ID. Keep its
permissions private and retain the original encryption key.

**Initial App owner handoff:** configure the OAuth client secret and exact GitHub callback/Setup
URLs in **Service operator setup** and GitHub, then perform real consent and installation.
Fixture success alone does not establish GitHub consent, organization approval, or a working
production callback. The owner subsequently completed real authorization and selected this
repository. Worker preparation was a separate blocker resolved by the capacity change below.
Do not send secrets through chat.

## Runtime settings

Use **Runtime** for the immutable worker image, allowed paths, forbidden paths, and verification
commands. **Connect GitHub** fills App and repository identity automatically. Legacy manual identity
fields remain under **Advanced GitHub identity** for existing operator workflows.
The advanced section exposes the existing scan, time, file, and patch-size limits. Concurrency
remains fixed at one coding job. No dispatch environment variable is required.

Enter one path pattern per line. Forbidden paths must name the target's security and deployment
source domains; Reina cannot infer a complete safe policy. Enter verification commands as JSON
argv arrays, for example `[["npm","run","ci"]]`, not shell command strings. Prepare the worker
before entering its immutable image ID; the form does not build images or weaken runtime controls.

Select **Save and apply configuration** to persist and apply an immutable configuration snapshot.
Saving complete settings can start scans and use model quota. Coding still requires an exact,
fresh human approval. A successful save is not proof that dispatch is running; inspect runtime
status. Refreshing status does not replace unsaved form edits.

The complete runtime record is AES-256-GCM encrypted in the existing settings schema 3. Responses
omit the webhook secret and report only its presence. Without matching service App settings, the first save requires a webhook secret of at least
32 characters. With a configured service App, Runtime inherits its matching secret. Leave the
secret field blank on later saves to keep the saved value. The browser
never receives the stored secret. Requests require an allowed session, exact Origin, and CSRF.
Runtime save requests are bounded at 512 KiB to include the permitted path lists, verification
argv, UTF-8 expansion, and JSON overhead; individual schema limits still apply.

Existing dispatch environment configuration remains a fallback only when no runtime record exists.
A saved record is authoritative, including when stale environment variables are present. Invalid
or undecryptable saved state fails closed; it does not reactivate the legacy configuration. After
saving the existing App ID and webhook secret in **Runtime**, remove their legacy environment
settings and the other dispatch variables. Keep the original encryption key and login bootstrap.
No settings schema migration or credential reset is required.

## Recover a worker fingerprint mismatch

`worker_dependency_fingerprint_mismatch` means the target snapshot's `package.json` or
`package-lock.json` does not match the prepared worker. The runtime compares each file's complete
SHA-256 before creating a triage or coding container. A version-only release, formatting change,
or dependency update can therefore require a replacement worker. This error is not an automatic
model retry. Removing `bot:triage-failed` or restarting does not repair the mismatch.

### Operator recovery procedure

This procedure does not authorize production changes, GitHub writes, or paid inference. The
**deployment operator** owns preparation and backups. The **Runtime administrator and provider
account owner** must authorize the affected issues, model use, and automatic publication before
applying the replacement. Use an authorized admin session; do not send credentials in chat.

1. **Record the baseline and preserve recovery state.** Record the remote default-branch commit,
   controller image ID, configured immutable worker ID from Runtime, affected issue numbers,
   and safe `triage_failed` reason/revision/correlation fields. An available image tag is not
   proof of the configured image. Keep issue bodies, raw model output, and secrets out of the
   incident record. Inspect pending requests and approvals before any restart or Runtime apply;
   those actions can resume other eligible work. Before production changes, follow the
   [stopped-instance backup procedure](architecture.md#operator-actions), including both
   databases, WAL state, the original encryption key, and previous image/configuration identities.
2. **Pin approved source bytes and compare both fingerprints.** Obtain a separate source copy of
   the approved commit without running its scripts on the host or creating a Git worktree.
   Confirm its two package files match that commit. Set `APPROVED_SHA` to its full commit SHA
   and `WORKER_ID` to the configured immutable image ID, then run these read-only checks in Bash
   from the source repository:

   ```bash
   set -euo pipefail
   : "${APPROVED_SHA:?Set the approved commit SHA}"
   : "${WORKER_ID:?Set the configured immutable worker image ID}"
   git show "${APPROVED_SHA}:package.json" | shasum -a 256
   git show "${APPROVED_SHA}:package-lock.json" | shasum -a 256
   docker image inspect "$WORKER_ID" --format \
     'manifest={{index .Config.Labels "io.reina.package-manifest"}} lock={{index .Config.Labels "io.reina.dependency-lock"}}'
   ```

   Image label values include the `sha256:` prefix. A missing image, package file, or fingerprint
   is a blocker, not permission to bypass the guard. Do not change package files merely to match
   an old worker or relabel an incompatible image.
3. **Prepare one replacement worker.** Authorize the required public image/package downloads
   and Docker write access in a reviewed preparation environment. Preparation has host-level
   Docker authority; do not expose production credentials or a shared host Docker socket to
   untrusted repository code. Agent-run repository code requires a fresh disposable sandbox
   with temporary source, a clean environment, no host secrets or sockets, and network access
   limited to required destinations. If these controls are unavailable, preparation remains an
   operator action. Run only one preparation at a time. Set `APPROVED_DIR` to the absolute path
   of the approved source copy and, from the reviewed preparation checkout, use:

   ```sh
   TARGET_DIR="${APPROVED_DIR:?Set the approved source directory}" \
     docker compose run --build --rm -T prepare-worker
   ```

   The command writes local image tags; it does not select the new worker in saved Runtime
   settings. Retain the previous immutable images and record the printed replacement image ID.
   On the controller's Docker daemon, repeat the fingerprint checks with that ID. Both labels
   must match the approved package bytes. Unsupported manifests, missing integrity, failed
   downloads, or cleanup failures must be resolved before applying; do not weaken preparation
   limits, omit required dependencies, or continue after an unsuccessful preparation.
4. **Recheck the target and apply only the worker change.** Re-read the remote default branch
   immediately before apply. If either package file changed since preparation, stop and prepare
   against the newly approved bytes; a different commit with identical package bytes does not
   itself require rebuilding dependencies. In **Runtime → Immutable worker image ID**, enter
   the verified replacement ID and select **Save and apply configuration**. Preserve unrelated
   settings and existing limits. Saved Runtime settings, not a changed local tag or stale
   environment variable, select the worker. The new image changes the policy binding and
   invalidates old results/proposals, but does not authorize another assessment. After readiness
   is confirmed, a permitted maintainer must add `bot:retriage` for each intended read-only retry,
   with separate live-use/cost authorization. If the label is already present, remove it and then
   re-add it to create a fresh transition. Do not reset SQLite records, replay consumed requests,
   clear publication intents, or treat this operation as coding authorization.
5. **Verify publication for each explicitly requested, still-eligible affected issue.** Require runtime
   readiness, a fresh review revision, `triage_completed`, one current summary, `bot:triaged`,
   and the matching `bot:needs-info` or `bot:needs-human` label when applicable. A fix candidate
   needs neither outcome label. Confirm `bot:triage-failed` is absent. Closed or skipped issues
   follow their inactive projection instead; record that state without claiming an assessment.
   `runtime_ready`, `triage_started`, or label removal alone is insufficient. Preflight checks
   isolation but does not compare a target snapshot's package bytes. Preserve existing PRs;
   `bot:pr_ready` can coexist with failure of a newer assessment. Any later coding needs current
   policy-bound authority and must not recreate an existing PR.

If a new failure reason appears, stop and investigate it without increasing budgets or weakening
controls. If apply fails or unexpected work starts, the operator must stop dispatch or stop the
controller within the authorized maintenance window and preserve state and resource identities.
Restoring the old worker cannot fix its mismatch with current source. Keep dispatch stopped until
source and worker match; do not restore a database merely to reset attempts. Reconcile any remote
comments, labels, branches, or PRs written before interruption. A local rollback does not undo
GitHub writes or restore valid coding authority.

### Worker fingerprint incident baseline (2026-11-17 UTC)

Read-only checks at 14:05 UTC found open issues
[#16](https://github.com/narumiruna/reina/issues/16),
[#27](https://github.com/narumiruna/reina/issues/27),
[#29](https://github.com/narumiruna/reina/issues/29),
[#31](https://github.com/narumiruna/reina/issues/31), and
[#34](https://github.com/narumiruna/reina/issues/34) labelled `bot:triage-failed`. Controller logs
recorded `worker_dependency_fingerprint_mismatch` on attempt 1 in cycles at 12:16–12:21 UTC,
before model invocation. Local HEAD and remote `main` were
`56ac776f58993a561509711b44e0ecf0880a2947`. PR #28 changed parser dependencies; PR #33 then changed
the package version to `0.4.0`, which also changed the manifest fingerprint.

Recorded controller image:
`sha256:e6f1dabf4737a6bc6f4e356a8ee9d0d6c9cfdd055a0db887ab2100223ad4bd37`.
Available `reina-worker:direct-requests` image:
`sha256:94911eea56d364acbb1571f550050235e122872d694cbf8bb53a5be03892765e`.
Its labels matched source revision `a17718c2b7b203b088263f70d435098e21c7cee1`:

| File                | Approved `56ac776` source SHA-256                                  | Available worker label SHA-256 (without prefix)                    |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `package.json`      | `e9e07b790153f65283fd6ef054c6924c3b0bb8dc57df74d1564e7d39241305a0` | `65ed131b3ea60bcf0449281a039a3416537b36422dfb9bc2ffd92d07bc78ad91` |
| `package-lock.json` | `0a7db460aa0c0c267235694c439f7cb803ed652e018cb9ec7a0563b2cf358f4e` | `e1623f37de470460db909f5e213b1db9fa0ea1a6c62b9554f7cf219d2ff570bf` |

The configured worker ID was not read through an authorized admin session; confirming it is a
Runtime-administrator prerequisite, not an inference from the available tag. No production image
was prepared or applied, and no model call or GitHub mutation was triggered by these checks.
The operator handoff above remains open. Production isolation and live recovery remain unverified;
do not describe this documentation change or passing fixtures as restored triage or release
acceptance. Retain the verifier, target/replacement IDs, authorized scope, per-issue current-cycle
results, and any unresolved checks before declaring production recovery complete.

## Onboarding

Obtain authorization for paid provider use and test-repository changes before completing dispatch
configuration. Once all settings are ready, the controller can start scans and process approvals.
A saved setting is not proof of successful remote authentication or provider compatibility.

1. Sign in with a Pocket ID account that belongs to an allowed group.
2. Open **GitHub App** and select **Connect GitHub**. Authorize the service App and choose an
   accessible repository; use **Install or manage App** if repository access is missing.
   - The service operator must first complete the one-time App setup above.
   - Ordinary connecting users do not upload PEM files or enter App/repository/installation IDs.
   - Connection does not start coding or replace the separate worker/policy review.
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
6. Complete the App, repository, policy, and immutable worker settings under **Runtime**.
   Follow [GitHub App configuration](../README.md#configure-the-github-app) and
   [worker preparation](../README.md#prepare-a-target-worker), then save and apply the configuration.
   App ID and webhook secret are Web UI settings, not required bootstrap variables. Model
   credentials are managed only in the UI.
7. Select **Refresh status** to inspect runtime status. Use **Apply configuration** to retry after
   fixing an external dependency. This is not a provider connection test.

There is no automatic paid provider connection test. **Subscription configured**, **Account
configured**, **API key configured**, the App's **Key configured** status, and saved model metadata
report local configuration only. They do not verify remote authentication, entitlement, compatibility,
or live acceptance. The [terminology reference](architecture.md#terminology) defines the status rules.

## Provider methods and limits

Reina uses the pinned pi-ai 1.5.2 provider registry and authentication implementations, not an
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

**Codex output-cap limitation:** SDK 1.5.2 ignores `maxTokens` for Codex and omits
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

### Runtime settings verification on 2026-11-13

The Runtime form, encrypted storage, write-only webhook secret, legacy fallback, and saved-setting
priority passed 1,299 credential-free tests and the TypeScript build. An isolated HTTPS browser
check used the real SQLite and administrative API at 320, 390, and 1440 pixels. It verified
login/group/CSRF checks, native and server-side validation, error focus, secret retention,
refresh draft preservation, and reload persistence. A separate mock-browser check covered pending
request locking and duplicate-submit prevention. No live model request was made.

The host runtime command passed the Compose fixture but could not run its 13 runtime cases because
macOS-host Unix sockets were unavailable to Linux workers. Running the same 13 cases in the current
controller image on the Linux daemon with short, identically mounted private staging paths passed
all cases. This includes real Pi with a local protocol fixture, not a paid provider. This evidence
does not establish acceptance on a different production Linux host.

The management image was deployed with existing settings, key, and selected model preserved.
In that initial run, all ten label definitions were created, but dispatch was unconfigured and
issue #16 had no bot summary or reviewed labels. Its approved target commit was
`16ea0177d9dfb524d921500624299388db77258d`. Worker preparation stopped at
`dependency_download_limit`: the preparation script downloads incompatible optional platform
packages. All 308 unique tarballs total 652.054 MiB, above the unchanged 128 MiB download budget.
Filtering to the actual Linux arm64/glibc platform would reduce downloads to 69.612 MiB, but does
not resolve the next boundary: the integrity-verified Linux Biome 2.6.4 binary is 80,354,976 bytes
(76.632 MiB), above the unchanged 32 MiB per-export-file limit.

This initial run could not start live triage with the old limits. The owner subsequently
explicitly authorized increased preparation capacity; the current bounds are documented below.
Do not omit required dev dependencies, change the approved lockfile, relabel an incompatible image,
or reset review state to force a retry. No coding approval,
coding job, or pull request was created. Both databases and the private environment were backed up
before deployment. Keep their original encryption key and restrict access to the backups.

### Dependency preparation capacity

The owner authorized raising the fixed dependency-preparation limits to support this repository's
native tooling. Each tarball/import is bounded at 64 MiB; cumulative downloads at 1 GiB; each
exported dependency file at 128 MiB; and total exported dependency content at 512 MiB. The raw
Docker dependency archive read is bounded at 576 MiB and dependency JSON input at 96 MiB. The
preparation-only workspace is 2 GiB. No environment variable or operator toggle is added.

Ordinary coding workspaces remain 256 MiB. Temporary files remain 64 MiB, memory 2 GiB, CPU one,
and process count 128. SHA512, registry-only downloads, approved manifest/lock fingerprints,
lifecycle-disabled offline installation, read-only root, no network, no capabilities, seccomp,
path/symlink validation, deadlines, and cleanup remain required. The preparation probe validates
its separate workspace size; it does not accept the larger quota for ordinary coding jobs.

### Worker activation verification on 2026-11-13

The actual target worker prepared successfully from commit
`16ea0177d9dfb524d921500624299388db77258d` with immutable image ID
`sha256:8c0047d1e0013c144519355a4123e9d6689db666ed1903874d856eeecfce99ae`.
Its manifest and lock SHA-256 labels match the approved source. Current main
`0340693712ca6dae983cb7ffd17ed32903a29563` changes only `scripts/pre-commit.sh`;
its dependency fingerprints are identical. An offline, read-only container verified Biome 2.6.4,
its 80,354,976-byte Linux arm64 binary, and TypeScript 7.0.2. Preparation resources were removed.

Capacity changes passed 67 boundary tests, the complete CI suite, the Compose fixture, and all
13 Linux runtime cases. A subsequent live scan exposed SDK token classification: the token-only
SDK labels a JWT-shaped installation token as an App token. The boundary now uses exact token
identity and trusted installation-issuance metadata instead of the syntax guess. Installation ID,
single repository, expiry, and issuance permission checks remain required. Regression tests use
the real installed SDK and deny missing or different-token proof.

The live Codex endpoint returned HTTP 200 and valid SSE without a `Content-Type` header. Only
the Codex adapter accepts that omitted header; explicit incorrect MIME types and missing MIME
for other APIs are rejected. SDK event validation, origin/DNS restrictions, response-byte limits,
deadlines, and completion checks remain required. A bounded live diagnostic completed. CI passes
1,566 tests. The Compose fixture and all 13 Linux runtime cases passed after these corrections.
Compose cleanup now includes its setup profile and asserts that its own networks are removed.
Twelve empty, label-verified old Reina test networks were removed after they exhausted the daemon's
address pool. No unrelated network or active resource was removed.

The private pre-activation backup is
`/Users/narumi/.local/state/reina/backups/20261113T152928Z-worker-capacity`.
It contains both SQLite backups, the private environment, and the prior controller image ID.
Keep its directory at `0700`, files at `0600`, and the original encryption key. Stop the single
controller before restoring compatible state and image together; reconcile remote GitHub state.
Never clear delivery, review, attempt, approval, or publication records to force a retry.

The single controller uses encrypted Runtime settings and reports `runtime_ready` for repository
1444545958 and installation 181493531. Deployed controller image:
`sha256:41356fa222c5a23088b9ca4f5f2607b1251a86a63a5b202990d77aa54e606d08`.
No new environment variables were added. Policy protects application, worker, script, frontend,
GitHub, and agent-instruction source paths.

### Live issue verification on 2026-11-13

The owner authorized capacity changes, bounded model use, and a read-only test. After correcting
both transport failures, a new [test comment](https://github.com/narumiruna/reina/issues/16#issuecomment-6858020178)
clarified the expected assessment and labels. It used normal webhook intake with changed issue
evidence. No delivery, review, attempt, or approval state was manually deleted or reset.

At 15:57 UTC, `gpt-6.1-sol` completed the assessment and `reinabot[bot]` published
[one triage summary](https://github.com/narumiruna/reina/issues/16#issuecomment-6858080755).
The App classified the issue as a test without an actionable code defect and returned
`needs_human`. GitHub confirms `bot:triaged` and `bot:needs-human`; numeric bot author 355975874
made both label changes and removed the previous `bot:triage-failed`. No label was applied
manually to claim success.

Durable review revision `8dc1483c-c321-4181-b24a-d134fc4c5bb3` is `complete`, with one attempt
for the new evidence, matching published revision, comment ID 6858080755, and no saved error.
The controller is healthy. Jobs, approvals, and proposals remain at zero; no issue-16 PR exists.
No owned job staging, worker containers, preparation resources, or test networks remain.

The initial background scan also encountered issue #12 before the model-stream correction.
Its permanent `pi_agent_error` and attempt record remain unchanged; it was not retried by resetting
state. This verification covers #16, not all open issues. Coding approval, useful fixes, PR creation,
provider billing, restore acceptance, and deployment on a different host remain outside this test.

## Applying settings and failures

Every successful settings mutation requests a controller reload. The controller first disables
webhook dispatch and stops current jobs. It then creates a new immutable runtime configuration
snapshot from saved runtime settings, bootstrap storage, and the selected model. Legacy dispatch
environment values apply only before the first runtime save. Workers cannot change that snapshot.
Schedule configuration changes for a maintenance period; they can cancel current work.

| Runtime state    | Operator action                                                                        |
| ---------------- | -------------------------------------------------------------------------------------- |
| `starting`       | Wait for application, then refresh settings. Webhooks return HTTP 503.                 |
| `not_configured` | Complete the model, App key, or Runtime settings indicated by the reason.              |
| `running`        | Configuration is applied; still complete authorized external acceptance.               |
| `failed`         | Check the reason, GitHub authentication, and sandbox controls. Do not relax isolation. |

For `cleanup_requires_operator_check`, dispatch is latched stopped. Repeated UI reloads cannot
clear it. Inspect and remove only Reina-owned orphan resources, confirm cleanup, then restart.
Follow [recovery procedures](architecture.md#operator-actions); do not clear job or publication
records to force a retry. Missing runtime controls never enable host execution.

## Secret storage and recovery

The runtime settings, webhook secret, App PEM, and typed provider credentials are encrypted with
AES-256-GCM in private `settings.sqlite` next to the job database. OAuth envelopes retain the complete SDK access/refresh
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
   schema 7 or settings schema 3 requires matching pre-upgrade backups. Review restored credentials
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
     and billing. For Codex, explicitly accept the SDK 1.5.2 upstream token-cap limitation above;
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

### i18next local verification on 2026-11-16

- `npm run ci`: all 1,763 tests, Biome, TypeScript, and the browser bundle build passed.
  Changeset and whitespace checks passed. Chromium fixture checks passed for both languages,
  draft inputs, delayed validation announcements, and narrow layouts under the self-only CSP.
- The Docker build stage passed with `npm ci --ignore-scripts`. The generated browser bundle
  worked after development dependencies were pruned.
- `npm run test:runtime`: 16 passed and one failed. The Compose test stopped at container creation:
  Docker reported that the staging volume path was `mounted on / but it is not a shared mount`.
  The unchanged baseline at `5ab37cf` failed at the same step with the same error. No sandbox or
  mount check was skipped or weakened.
- The deployment operator must rerun the full runtime suite on a Docker host that supports the
  required staging mount. This environment failure does not waive the production Linux release
  gate or establish production runtime acceptance. These checks used no live provider or GitHub
  credentials and made no paid requests.

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

### Live mention-request acceptance (2026-11-16 UTC)

The following evidence is from the local Compose deployment targeting `narumiruna/reina`,
not from dummy GitHub fixtures. These checks ran against the local implementation worktree
before its changes were committed. The deployed controller image at this checkpoint was
`sha256:b06c62356a1a32b72b068017bbc328d860ffeac0a67054f8d5601020a807332d`.

- **Mention help:** [source comment](https://github.com/narumiruna/reina/issues/25#issuecomment-6923246046)
  received [the App's usage reply](https://github.com/narumiruna/reina/issues/25#issuecomment-6923551218).
  GitHub recorded an initial delivery timeout before intake. One official GitHub redelivery of
  the same GUID produced the reply; no synthetic event or database reset was used.
- **Mention to draft PR:** [the human request](https://github.com/narumiruna/reina/issues/25#issuecomment-6922680761)
  produced [draft PR #26](https://github.com/narumiruna/reina/pull/26), authored by `reinabot[bot]`
  (user ID `355975874`), without a separate `bot:approved` label.
  Job `bf733a5c-9411-4fbb-8474-9e392b60b92c` reached `pr_ready` with artifact hash
  `56cba3cb85db2178c0595d6cb06f2123a8451d69d519bb7c025862135b4a39f2`.
  Head `89234d93fe618c9d814c095978809db729170e1c` targets main
  `a17718c2b7b203b088263f70d435098e21c7cee1`. The two added files are
  `tests/branch-names.test.ts` and `.changeset/branch-name-tests.md`, both mode `100644`.
  The latter contains exactly `---\n---\n`, the required empty Changeset for this test-only change.
- **Independent verification:** `npm run check`,
  `npm test -- --configLoader runner --cache=false`, and `npm run build` all exited `0` in
  worker image `sha256:94911eea56d364acbb1571f550050235e122872d694cbf8bb53a5be03892765e`.
  [GitHub Actions run 43911419491](https://github.com/narumiruna/reina/actions/runs/43911419491)
  also passed both `ci` (including Changesets) and `runtime` on that exact head.
  At this checkpoint, the local worktree passed 1,947 unit tests, the build, Changesets validation,
  and all 19 Linux runtime tests with zero skips. No verification gate was removed or narrowed.
  PR #26 was later merged; these results describe its original draft head.
- **Publication recovery:** earlier test PR #24 established recovery from saved validated
  artifacts without repeating coding. Git data JSON omitted the final LF from the commit
  message while retaining it in the hashed Git object. The publisher now accepts only that
  exact normalization. PR #24 and its issue #23 were closed as superseded. Reina did not merge
  any PR or delete any branch during these checks.
- **Blocked native assignment:** the repository owner's assignee check succeeds, but the
  App bot's check returns `404`; a real assignment attempt returned `403`, and GraphQL
  returned `FORBIDDEN`. Existing App write permissions do not make this identity assignable.
  The assignment handler is covered by regression tests, but no live native-assignment success
  is claimed. It currently uses the verified App bot ID; no alternate account setting was added.
  To continue, the App owner must obtain GitHub assignment eligibility for this identity or
  provide an assignable dedicated bot account and authorize separate-identity support.
  A login is sufficient for that handoff; do not send account tokens or passwords.

### Schema-6 deployment acceptance (2026-11-16 UTC)

Commit `af853188641df94e1ce63937848e4836e3fded9a` was deployed after the review follow-up,
using a consistent stopped-instance backup and a retained rollback image. Controller image
`sha256:29edd479eb1a2d733d1896167b2769d1eafd7aba2751d415ed5161581f02a45a`
matched all 15 changed compiled modules. Migration advanced job schema 5 to 6 with cutoff
`1794854848596`; all five historical jobs retained their state, proposal, artifact, and commit
identities. Settings schema 3 and the encrypted trusted-dispatch settings were unchanged.

The fresh [request on issue #29](https://github.com/narumiruna/reina/issues/29#issuecomment-6925805076)
produced [draft PR #30](https://github.com/narumiruna/reina/pull/30) from
`reinabot[bot]` without an approval label. Job `243ad984-8a6f-47e9-bff8-1628f62e1f59`
reached `pr_ready`; receipt key
`0f81f3c975d0caa1ce1640f6ed47e66443dd2b3039d727e3fb55ab91086d3f52` remained after
completion with zero retries. Artifact
`bf9612389a19177affed2fb5bd5b4ffa24b56611b41614a3ddeeb38efd97dd9f` matched the exact
remote files and modes at head `8abf2deb3ce68ce14d213853d1dabf329a7c3f31` on base
`f449ce0b90a2813fc6408cccd4d90f8edf1bb8c6`. The existing tests were preserved, two positive
boundary cases were added, and the empty Changeset contained exactly `---\n---\n`.
All three independent verification commands exited `0` in the expected immutable worker.
[GitHub Actions run 43934040450](https://github.com/narumiruna/reina/actions/runs/43934040450)
passed both `ci` and `runtime` on the exact head.

This checkpoint predates the later CommonMark parser follow-up. It verifies the schema-6
migration and fresh request pipeline, not a live native-assignment success or deployment of
later commits. Native assignment still requires an eligible GitHub identity.

### Issue-triage acceptance handoff

This is an owner-operated acceptance procedure, not permission for live writes or paid inference.
Current issue-triage test evidence must be recorded separately from the historical counts above.
The `bot:retriage` workflow, schema-7 production upgrade, real label-delivery/removal races, and
paid-provider behavior remain owner acceptance checks. Do not enable paid dispatch until the
required production-host checks and owner acceptance pass, or an explicit exception is recorded.

1. **App owner and repository maintainer**
   - Prerequisites: authorize disposable issues and bounded provider use; confirm minimum App
     permissions/events, all eleven label definitions, and safe target CI.
   - Actions: submit a clear small fix, missing reproduction details, and a product decision.
   - Expected: one mutable summary per issue with kind and host outcome. Needs-info gets
     `bot:needs-info`; a human decision gets `bot:needs-human`. `bot:triaged` follows confirmed
     summary/outcome publication. `fix_available` follows a separate immutable proposal.
     The label-based path needs fresh approval of that exact proposal. A permitted human's
     explicit mention request, or supported bot assignment, can instead delegate one policy-bound
     attempt without an additional label. Both paths publish the immutable proposal before coding.
     Inspect one draft PR through separately authorized coding work. Evidence/base/policy changes
     and 24-hour proposal expiry never automatically renew assessment. For each read-only
     reassessment, add `bot:retriage`. If the label is already present, remove it and then re-add
     it to create a fresh transition. Verify no code, job claim, or PR from that trigger, including
     with old approval labels or resumed older coding receipts.
     A fresh explicit coding request remains a separate delegation.
     Native assignment must first pass GitHub's assignee-eligibility check;
     the current `reinabot[bot]` App is rejected by GitHub.
2. **Repository maintainer and operator**
   - Prerequisites: authorize disposable edit, failure, and restart scenarios; retain saved state.
   - Actions: edit the issue; add/edit/delete a human comment; close or add `bot:skip`; check
     missed-event scans, incomplete/deleted evidence, publication interruption, and restart.
   - Expected: stale-state removal, one updated summary, and no own-comment/label inference loop.
     Closure/skip makes the summary inactive and removes all four triage labels without inference.
     Unavailable/incomplete evidence invalidates the review without claimed successful writes.
     Read recovery preserves the saved model error and consumed allowance. A summary
     conflict clears the reviewed claim without editing foreign comments. One trusted, scoped
     triage summary does not consume the ordinary 100-comment/128-KiB evidence budget.
     Publication recovery reuses the saved result. Exactly one initial invocation is the maximum;
     timeout, transient error, interruption, and invalid output never grant background retries.
     Scans, edits, base/policy changes, reopening, and restart cannot increase invocation counts.
     Confirm a new permitted human label transition is needed after failure. Replay the same
     source with a different delivery GUID and check that it cannot grant another run.
     Check permission loss, ambiguous or incomplete history, and uncertain cleanup fail closed.
   - For a same-owner rename, update the configured repository name. Confirm that live numeric
     identity checks permit recovery, the summary is reused, and any replacement proposal needs
     a fresh human request or approval. Do not use this path for owner transfers or
     cross-repository moves.
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
   - Actions: check supported job migrations through schema 7 separately from settings schema 3; test restore,
     permissions, quotas, cleanup, and the complete runtime suite. Verify legacy pending/running
     work cannot restore inference eligibility. Reconcile restored GitHub state and later consumed
     receipts: an older backup does not preserve the single-shot guarantee by itself.
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

The historical fixture results alone do not establish live acceptance. The narrow
[live issue verification](#live-issue-verification-on-2026-11-13) above records #16's real result;
it does not establish acceptance of the separate coding and approval scenarios. See
[architecture and operations](architecture.md) for isolation limits and publication recovery.
