# reina

## 0.2.0

### Minor Changes

- 83a51fe: Add Connect GitHub for the existing service App. Reuse accessible installations, use GitHub's official OAuth and installation screens, and let users select a verified repository without entering repository or installation IDs. Keep one-time service App setup separate from ordinary connection.

  Use session-bound single-use state and OAuth PKCE. Verify App identity and GitHub user installation/repository access, then revalidate before selection. Keep user tokens in bounded server memory only and cancel stale flows on logout, expiry, shutdown, or App/key changes. Encrypt operator App credentials and verified repository bindings in the existing settings database; keep secrets write-only.

  Automatically fill Runtime identity from the selected connection without granting coding approval. Require matching App/repository bindings and separate worker/policy configuration before dispatch. Keep legacy deployment compatibility and existing worker limits.

  Make incomplete service setup actionable: Connect GitHub opens and focuses the missing setting. Remove accidental surrounding whitespace from pasted OAuth client secrets while rejecting empty values and embedded control characters; preserve exact webhook secrets.
- 21f4b14: Add a Pocket ID-protected administration interface for pi-ai providers, models, and GitHub App PEM uploads. Store credentials encrypted in SQLite with ENCRYPTION_KEY. Replace model and private-key environment configuration with authenticated Web UI settings.

  Replace subject authorization with OIDC_ALLOWED_GROUPS: comma-separated, exact, case-sensitive Pocket ID group Name values, such as reina-admins. Any matching group grants full administration. The default is empty and locks login; there is no automatic user administrator group. Request openid profile groups and authorize only a bounded string array in the verified signed ID-token groups claim. Subject, email, user name, group UUID, and Friendly Name values do not authorize access; sub remains session identity only. The public Pocket ID claim documentation describes unreleased behavior, so the client owner must confirm deployed claims with OIDC Data Preview, without public service probing.

  Migrate settings schema version 1 to 2 by adding sessions.groups JSON and deleting legacy sessions. Preserve providers, models, encrypted credentials, the saved App PEM, and the original encryption master key. Include group policy in the authentication-context digest; changes to issuer, client ID, public origin, or allowed groups invalidate sessions at startup. Recheck configured groups against stored login-time groups on every authenticated request.

  Keep the eight-hour session maximum. Pocket ID membership removal is not immediate session revocation: there is no live membership refresh or back-channel logout. Membership updates at the next login; expiry requires a new login. Restart alone with an unchanged authentication context does not refresh membership.

  Add method-first provider setup: choose account or API key, search compatible SDK providers, then complete SDK-owned prompts. Keep the explicit custom endpoint/protocol/key form under API-key setup. Account flows support OpenAI Codex, Anthropic, GitHub Copilot, Kimi Coding, Meta, and xAI. Copilot supports public github.com only and requires separate confirmation before SDK login can enable remote model policies. The server fixes headless SDK choices. Callback-based OpenAI ChatGPT and OpenRouter account methods, Radius pi-messages, extra callback ports, browser credential storage, and host Pi auth imports are not supported. API-key methods remain available where SDK models fit supported protocols; OpenAI API keys are not Codex account credentials. Provider OAuth is separate from Reina's Pocket ID sign-in.

  Align interface wording with pinned Pi 1.5.0: Configure provider, Select authentication method, Built-in provider, Select model, and Maximum output tokens setting. Preserve SDK names, including OpenAI Codex (legacy), and provider-specific login labels. Subscription status requires explicit SDK isSubscription true; configured credentials remain local status, not verified entitlement. Reuse SDK AuthType and expose only supported methods' read-only authDetails presentation metadata, not SDK auth objects or credentials. Add the retained [terminology reference](../docs/architecture.md#terminology) and a local before/after wording-review handoff. This terminology change does not alter identities, schemas, configuration, authentication, refresh, approvals, security limits, runtime behavior, or dependencies. Keep the Codex cap warning, selected-versus-running distinction, and separate credential-removal and logout boundaries. No live provider calls are needed for wording review; existing external acceptance gates remain open.

  Upgrade settings to schema 3 with encrypted typed api_key/oauth credentials, SDK provider identity, and logical credential generations. Transactionally migrate legacy API keys while preserving the App PEM, providers, models, active selection, and schema-2 sessions. The earlier schema-1 group migration still removes unverified sessions. Failed migration rolls back. Keep the original ENCRYPTION_KEY and a consistent pre-upgrade backup of all databases, including WAL state. Downgrading requires that matching backup; review restored credentials and revoke affected restored sessions before dispatch.

  Bind staged setup to its initiating session, with a 15-minute maximum, 64 total flows, and four active flows per owner. Reject cross-session access and stale prompts; cancellation, expiry, owner logout/session invalidation, and shutdown stop pending work. Atomic generation-checked commits prevent late or failed setup from replacing prior credentials or selection. Saving credentials or models never selects a model. Credential replacement changes modelRevision and requires fresh proposal approval; normal refresh within the same generation does not. Credential removal stops affected work and clears its selection while retaining models.

  Resolve model authorization only on the host through SDK Models.getAuth() and ModelAuth, preserving SDK headers, model compatibility, and validated public Copilot endpoints. Serialize credential rotation and deletion with atomic compare-and-swap generation checks so late refresh cannot overwrite replacement or restore deleted credentials. Failed refresh preserves credentials and returns a safe reconnect error without fallback. Keep secrets and native continuation metadata out of workers, browser storage, job/proposal records, and logs.

  Add the distinct openai-codex-responses transport without injecting unsupported wire fields. SDK 1.5.0 ignores Codex maxTokens and omits max_output_tokens: an exact upstream 4,096-token Codex cap is not enforced or claimed. Request-count, body-size, response-byte, and time budgets remain; other supported SDK adapters apply at most 4,096 output tokens or the lower saved limit. Codex production use requires owner-authorized bounded live acceptance of this limit and billing behavior. Configured credentials are not remote authentication or entitlement proof. Retain owner-operated MFA, subscription, live rotation, paid-inference, and test-repository acceptance, plus the production Linux runtime release gate; existing macOS/OrbStack baseline failures are not runtime acceptance.
- 46c0ff4: Publish durable read-only issue assessments with classification and a host-derived fix-candidate, needs-info, or needs-human outcome. Maintain one mutable triage summary separately from immutable fix proposals and fresh human approval. Add operator-provisioned bot:triaged, bot:needs-info, bot:needs-human, and bot:triage-failed labels; a reviewed label means confirmed assessment publication, not an attempt, verified fix, or permission to code.

  Persist bounded three-attempt assessment cycles with one-minute/five-minute retries for allowed transient failures, failure suppression until evidence or policy changes, and separate 24-hour successful fix-candidate renewal. Recover publication from saved results without inference. Invalidate changed evidence, prevent own-comment/label loops, and reconcile stored reviews independently of open-issue discovery, including closed, skipped, deleted, and incomplete evidence.

  Migrate job database reina.sqlite from schema 4 to 5 transactionally while preserving existing authority and work records. Encrypted settings.sqlite remains schema 3. Require consistent stopped-instance backups with WAL state and the original ENCRYPTION_KEY; downgrades require matching backups, and restoration does not undo GitHub writes. Document safe lifecycle logs, label setup, recovery, and verifier-specific external acceptance. Existing Pocket ID authorization, provider limits including the Codex upstream cap limitation, worker isolation, and production Linux runtime release gates remain in force.
- 83a51fe: Add authenticated Runtime settings for GitHub App identity and webhook secret, repository and installation identity, immutable worker image, path policy, verification commands, and existing operational limits. Store the complete record encrypted in the existing settings database and return only safe metadata. Keep webhook secrets write-only and preserve them when omitted on updates.

  Apply saved settings through the existing fail-closed controller reload. Saved runtime settings override legacy dispatch environment configuration; legacy values remain a fallback only before the first runtime save. Keep encryption, login, listener, and storage bootstrap settings external. Require the existing session, Origin, and CSRF checks for runtime changes. Saving can start scans and model requests but never grants coding approval.

### Patch Changes

- 74ce580: Accept valid leading-dot repository names and managed-user logins throughout GitHub discovery, selection, and encrypted settings. Keep repository-owner, path, identity, and access checks strict.

  Keep Runtime connection identity current after settings reloads. Preserve same-target drafts and validation, require review for target changes, and restore manual identity controls after disconnection. Explain that a matching saved Runtime can resume scans and model use on repository selection; coding still needs separate approval.

  Stage dependency tarballs in the preparation workspace so exact 64 MiB imports fit without increasing ordinary temporary-storage or job quotas. Verify real import bounds, cache cleanup, and offline lifecycle-disabled installation.
- cfb214b: Format the generated changelog after Changesets versions the package. Release pull requests now use the same Biome format as CI, including multiline release notes. Keep formatting checks enabled and stop if version generation fails.
- 83a51fe: Increase bounded dependency-preparation capacity to support larger native tooling: 64 MiB tarballs/imports, 1 GiB cumulative downloads, 128 MiB individual dependency files, 512 MiB dependency content, 576 MiB raw dependency archive reads, and 96 MiB dependency JSON input. Use a separate 2 GiB preparation workspace.

  Keep ordinary 256 MiB coding workspaces, 64 MiB temporary filesystems, CPU/memory/process/network restrictions, registry and SHA512 verification, approved dependency fingerprints, lifecycle-disabled installation, archive validation, deadlines, and cleanup. Add no environment variables or feature flags.

  Accept JWT-shaped installation tokens only with matching trusted issuance metadata. Keep exact token, installation, repository, expiry, and permission checks instead of relying on the SDK's token-format classification.

  Support Codex SSE responses with an omitted Content-Type header while retaining event, byte, deadline, and origin validation. Reject incorrect MIME types and keep other APIs strict. Remove setup-profile networks during Compose fixture cleanup.
- 7129267: Make failure logs visible without exposing private request or error data. Record original job failures before label updates, use error severity for failures, and keep expected cancellation and deferral events at info severity. Include issue-local execution deferrals without changing consumed approvals, job states, labels, or publication recovery. Log failed runtime cleanup, preserve explicitly allowed startup reason codes, and record unexpected HTTP failures with safe method, route, and status fields.

## 0.1.1

### Patch Changes

- 513c85d: Add Docker Compose startup and an optional approved-snapshot worker preparation service.

## 0.1.0

### Minor Changes

- 8cb57dd: Add the approval-gated Reina GitHub App with durable state, isolated Pi workers, trusted validation, and draft pull request publication.

### Patch Changes

- d825b3f: Isolate issue evidence limits, resume explicitly rejected publication writes after backoff, and prevent new worker dispatch during shutdown.
