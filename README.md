# Reina

Reina is a Probot GitHub App that proposes small issue fixes. A maintainer must approve the exact
proposal before Pi changes code. Validated changes become a **draft pull request**. Reina never
merges a PR or enables auto-merge.

The MVP supports one Node/npm repository, one service instance, and one coding job at a time.
It requires persistent local storage and a prepared Docker worker. Missing isolation prevents
execution; there is no host subprocess fallback.

## Run with Docker Compose (Linux)

Use a local Linux Docker Engine with cgroup v2, built-in seccomp, and Docker Compose.
Host Node.js and npm are not required. Remote Docker daemons and Docker Desktop are not supported
by this layout.

1. Copy the configuration and fill in the App, repository, and model credentials described in
   [Configure the GitHub App](#configure-the-github-app).

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

   Single-quote secrets that contain `$` or `#`. Use a single-quoted PEM value with literal
   `\n` newline escapes for `PRIVATE_KEY`.

2. Obtain a separate checkout of the approved target commit. Set `TARGET_DIR` in `.env` to its
   path, for example `TARGET_DIR=../my-app`. Relative paths are resolved from `compose.yaml`.
   This is the repository Reina will fix, not a special Reina directory. Its two npm manifests
   must match the approved commit. Do not run target scripts on the host.

3. Prepare the worker once through Compose. Run only one preparation at a time.

   ```sh
   docker compose run --build --rm prepare-worker
   ```

   This pulls the fixed Node base and runs the existing isolated preparation process. Copy the
   printed `sha256:...` image ID into `REINA_WORKER_IMAGE` in `.env`, not the mutable
   `reina-worker:local` tag. Prepare again when target dependencies change.

4. Start the service.

   ```sh
   docker compose up --build -d
   docker compose logs -f reina
   ```

   The service listens on `127.0.0.1:36816` on the host by default. Set `PORT` in `.env` to
   use another port. Configure HTTPS ingress to `/api/github/webhooks`. Check HTTP availability
   with `curl http://127.0.0.1:36816/healthz`.
   This check does not establish live App/provider acceptance or continuous worker isolation.

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
Its `package.json` and npm v3 `package-lock.json` must match that commit.

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
4. Configure HTTPS ingress to `/api/github/webhooks`. The default loopback port is 36816.
   Use a strong webhook secret of at least 32 characters and configure the same value in GitHub.
5. Copy `.env.example` to `.env`, supply credentials through a secret manager or local untracked
   file, and set the repository/installation IDs and the prepared image.
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

Do not copy host Pi authentication files into a worker. The MVP uses an OpenAI Chat
Completions-compatible streaming provider through a bounded gateway. It requires API-key
authentication and `max_tokens` support; OAuth subscription providers and other wire protocols
are not implemented. Real provider compatibility must be checked before live dispatch.

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
base movement, scope changes, policy changes, or a different worker image require a fresh proposal
and approval. A scan never turns an existing approval label into execution authority.

See [Architecture and operations](docs/architecture.md) for security boundaries, limits, recovery,
verification evidence, and required external acceptance. Credential-free checks do not establish
live deployment or product acceptance.

## Release tooling

Changesets and the template release workflow are retained. This application is marked private
to prevent unintended npm publication. Deployment does not use `npm run release`.
Package publication, version tags, and release-workflow dispatch require separate authorization.
