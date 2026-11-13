# Reina

Reina is a Probot GitHub App that proposes small issue fixes. A maintainer must approve the exact
proposal before the Pi coding agent changes code. Validated changes become a **draft pull request**. Reina never
merges a PR or enables auto-merge.

The MVP supports one Node/npm repository, one service instance, and one coding job at a time.
Dispatch requires persistent local storage and a prepared Docker worker. Missing isolation prevents
execution; there is no host subprocess fallback. The authenticated admin Web UI can start before
GitHub, repository, model, or worker configuration is complete. See [Admin Web UI](docs/admin-webui.md)
and the retained [terminology reference](docs/architecture.md#terminology).

## Run with Docker Compose (Linux)

Use a local Linux Docker Engine with cgroup v2, built-in seccomp, and Docker Compose.
Host Node.js and npm are not required. Remote Docker daemons and Docker Desktop are not supported
by this layout. OrbStack is unverified.

1. Create the private bootstrap file.

   ```sh
   cp .env.example .env
   chmod 600 .env
   openssl rand -hex 32
   ```

   Set `ENCRYPTION_KEY` to the generated 64 hexadecimal characters. Keep this key; existing
   encrypted state cannot be opened with a replacement key. Single-quote secrets that contain
   `$` or `#`. Never commit `.env`.

2. Have the account owner configure the Pocket ID confidential client and group allowlist.
   Set `PUBLIC_URL=https://reina.narumi.dev`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET`, and `OIDC_ALLOWED_GROUPS`. Use comma-separated, exact Pocket ID group
   **Name** values, for example `reina-admins`. Matching is case-sensitive; any matching group
   grants full administration. Do not use subjects, email addresses, user names, group UUIDs,
   or **Friendly Name** values. The exact callback is
   `https://reina.narumi.dev/auth/callback`; scopes are `openid profile groups`.
   The group allowlist defaults to empty, which locks login. There is no automatic `user`
   administrator group or authentication bypass. Missing OIDC settings also lock login.
   Have the client owner confirm the deployed signed ID-token `groups` claim with OIDC Data
   Preview; the [public claim documentation is unreleased](https://pocket-id.org/docs/guides/scopes-and-claims).
   See [authorization and session limits](docs/admin-webui.md#authorization-and-sessions).

3. Configure the realm's TLS reverse proxy for `https://reina.narumi.dev` to
   `127.0.0.1:36816`, preserving the original `Host` header. Start the service.

   ```sh
   docker compose up --build -d
   curl --fail http://127.0.0.1:36816/healthz
   ```

   This checks HTTP readiness only, not login, dispatch, or live App/provider acceptance.
   The listener remains on loopback. `PORT` defaults to `36816`.

4. Open the HTTPS entrypoint and follow [Admin Web UI onboarding](docs/admin-webui.md).
   Upload the GitHub App PEM there; provider accounts, API keys, and models are also managed there.
   Complete [GitHub App configuration](#configure-the-github-app) and
   [worker preparation](#prepare-a-target-worker) before dispatch. Incomplete configuration
   keeps dispatch disabled and returns HTTP 503 for webhooks. Applying complete settings can
   start work; obtain live-test and paid-provider authorization first.

Compose uses host networking to preserve the loopback listener. Only the trusted controller runs
as root and receives the Docker socket; socket access gives it host-level control. Use a dedicated,
patched host. Job containers do not receive the socket, credentials, or host networking.

State is stored in the `reina-state` named volume at `/var/lib/reina`; Compose overrides
`REINA_STATE_DIR` with this container path. Private staging uses the host directory
`/var/lib/reina-tmp`, mounted at the same absolute path so host Docker can bind snapshot
directories and Unix sockets into jobs. The entrypoint sets both directories to mode `0700`.
Do not use the staging directory for another application or change its mount path.

Run only one instance. Stop with `docker compose down`, which keeps state. Do not use
`docker compose down --volumes` for a normal stop or recovery. Before upgrades, stop the service
and follow the [state backup and recovery procedure](docs/architecture.md#operator-actions).
All live deployment restrictions in that document still apply.

## Development

Use Node.js 26, npm, Docker with Linux containers, Docker Compose, and Git.

```sh
npm ci
npm run ci
npm run test:runtime
```

`npm run ci` runs Biome, credential-free Vitest tests, and the TypeScript build. CI separately runs
`npm run check:changesets` on pull requests, except the generated `changeset-release/main` release
PR, which has already consumed its changesets. Runtime tests use
the real pinned Pi CLI, Docker, and a local protocol fixture, not a paid model or real GitHub App.
They also build the controller image and check Compose worker preparation, shared snapshot/socket
mounts, and state persistence. They require the pinned Node base image locally:

```sh
docker pull node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567
npm run test:runtime
```

Worker preparation downloads trusted build tools and integrity-checked public npm tarballs.
It does not execute repository lifecycle scripts. Tests fail, rather than skip, when required
runtime controls are unavailable. Husky runs Biome migration, formatting, and lint fixes before
commits; it does not run the full CI suite.

## Prepare a target worker

Obtain the approved target commit in a separate directory. Do not execute its scripts on the host.
Its `package.json` and npm v3 `package-lock.json` must match that commit. For Compose, set
`TARGET_DIR` in `.env` to that checkout (relative paths are resolved from `compose.yaml`), then run:

```sh
docker compose run --build --rm prepare-worker
```

Run only one preparation at a time. This pulls the pinned Node base and prepares the isolated
worker. For direct host operation, use:

```sh
npm run prepare:worker -- /absolute/path/to/approved-snapshot reina-worker:local
```

Save the printed immutable image ID as `REINA_WORKER_IMAGE`. The worker contains Pi 1.5.0 and
immutable target dependencies. At runtime, both package files must match its fingerprints.
Prepare another image when dependencies change; changing the image invalidates old proposals.
Git trees with symlinks/submodules, workspaces, non-registry dependencies, missing integrity,
or dependencies requiring lifecycle scripts are not supported.

## Configure the GitHub App

1. Register a GitHub App and install it only on the target repository.
   - Create the label definitions `fix_available`, `bot:approved`, `bot:working`, `bot:pr_ready`,
     `bot:failed`, and `bot:skip`. Reina applies status labels but does not provision their definitions.
2. Give it Metadata read, Contents read/write, Issues read/write, and Pull requests read/write.
   Do not grant Actions or Workflows write, administration, or organization-member access.
3. Subscribe to Issues, Issue comment, Pull request, Push, Repository, Installation, and
   Installation repositories events.
4. Set the webhook URL to `https://reina.narumi.dev/api/github/webhooks`.
   Use a strong webhook secret of at least 32 characters and configure the same value in GitHub.
5. Set `APP_ID`, `WEBHOOK_SECRET`, the repository/installation IDs, and the prepared image in
   the private environment file. Upload an unencrypted RSA PEM key (at least 2048 bits, at most
   32 KiB) through the authenticated Web UI. It returns status and fingerprint metadata, never
   the saved key.
6. Review the allowed paths, domain-specific forbidden paths, and trusted verification argv for
   the target. An App installation is not a repository allowlist.
7. Check target CI before enabling publication. Draft PRs and App branch pushes can run workflows.
   Bot branches must use disposable runners without secrets, write tokens, privileged containers,
   or deployment access. Reina does not isolate or control external CI.
8. Provide a private persistent state directory outside the checkout. Start only one instance.
   Compose manages this directory in its named volume.

Use the [Compose startup](#run-with-docker-compose-linux) above, or start directly on the host:

```sh
npm run build
node --env-file=.env dist/index.js
```

In **Configure provider**, use **Select authentication method** to choose **Sign in with an
account** or **Sign in with an API key**, then search compatible providers. Built-in providers use
SDK prompts and provider-specific login labels. Custom public HTTPS endpoints use **Add custom
provider**, a separate API-key form. Saving a credential or model does not select a model.
Choose **Select model** separately, then inspect runtime status for configuration application.
Do not import host Pi authentication files.

Account login supports OpenAI Codex, Anthropic, GitHub Copilot, Kimi Coding, Meta, and xAI.
Copilot supports public `github.com` only and needs separate confirmation because SDK login can
enable model policies remotely. The callback-based OpenAI ChatGPT and OpenRouter account methods
and Radius (`pi-messages`) are unsupported. API keys remain available where SDK models fit the
supported protocols. **OpenAI API keys are not OpenAI Codex account credentials.** No extra callback
port or browser credential storage is used; Reina fixes the SDK's headless method on the server.

The host gateway supports `openai-completions`, `openai-responses`, `anthropic-messages`,
`google-generative-ai`, and `openai-codex-responses`. Input is text/tool-only; the Pi coding agent
uses thinking level Off (`--thinking off`), which does not promise that provider reasoning is disabled.
Supported non-Codex SDK output caps are at most 4,096 tokens, or the lower saved limit.
**Codex limitation:** SDK 1.5.0 ignores `maxTokens` and omits `max_output_tokens`. Reina does not
inject unsupported wire fields and does not enforce or claim an exact upstream 4,096-token cap
for Codex. Request-count, body-size, response-byte, and time budgets still apply. The account owner
must authorize bounded live acceptance, including billing and this limit, before production use.
Saving a credential is local configuration, not proof of remote authentication or entitlement.
See [provider setup and limits](docs/admin-webui.md#provider-methods-and-limits).
Legacy model environment variables are rejected by `loadConfig`; configure models in the UI.

## Issue workflow

- Open an actionable issue or wait for the bounded periodic scan.
- Reina reads the issue and source in an isolated read-only environment.
- An eligible proposal gets `fix_available` and a comment with exact files, checks, risks, and expiry.
- A human with write, maintain, or admin permission adds `bot:approved`.
- Approval must follow publication of that revision. If necessary, remove and re-add the label.
  Same-second approval/comment ordering is rejected because GitHub timestamps lack sufficient precision.
- Reina checks the current issue, proposal, permissions, approval history, and exact base SHA.
- Coding and independent offline validation run in separate disposable containers.
- A successful result produces one draft PR and `bot:pr_ready`. Failures get `bot:failed`.
- Remove approval, close the issue, or add `bot:skip` to stop pending work and cancel running work.
  A failed/interrupted attempt needs a new human approval transition.

Labels are not the job database. Proposals expire after 24 hours. Material issue/comment changes,
base movement, scope changes, policy changes, a changed model configuration, or a different worker
image require a fresh proposal and approval. Credential replacement changes `modelRevision` and
requires fresh approval. OAuth refresh within the same logical credential generation does not
change approval authority. Credential removal stops affected work and clears its model selection.
A scan never turns an existing approval label into execution authority.

See [Architecture and operations](docs/architecture.md) for security boundaries, limits, recovery,
verification evidence, and required external acceptance. Credential-free checks do not establish
live deployment or product acceptance.

## Release tooling

Changesets and the template release workflow are retained. This application is marked private
to prevent unintended npm publication. Deployment does not use `npm run release`.
Package publication, version tags, and release-workflow dispatch require separate authorization.
