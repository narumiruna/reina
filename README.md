# Reina

Reina is a Probot GitHub App that proposes small issue fixes. A maintainer must approve the exact
proposal before Pi changes code. Validated changes become a **draft pull request**. Reina never
merges a PR or enables auto-merge.

The MVP supports one Node/npm repository, one service instance, and one coding job at a time.
It requires persistent local storage and a prepared Docker worker. Missing isolation prevents
execution; there is no host subprocess fallback.

## Development

Use Node.js 26, npm, Docker with Linux containers, and Git.

```sh
npm ci
npm run ci
npm run test:runtime
```

`npm run ci` runs Biome, credential-free Vitest tests, and the TypeScript build. CI separately runs
`npm run check:changesets` on pull requests, except the generated `changeset-release/main` release
PR, which has already consumed its changesets. Runtime tests use
the real pinned Pi CLI, Docker, and a local protocol fixture, not a paid model or real GitHub App.
They prepare a disposable test image and require the pinned Node base image locally:

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
4. Configure HTTPS ingress to `/api/github/webhooks`. The service listens on loopback port 3000.
   Use a strong webhook secret of at least 32 characters and configure the same value in GitHub.
5. Copy `.env.example` to `.env`, supply credentials through a secret manager or local untracked
   file, and set the repository/installation IDs and the prepared image.
6. Review the allowed paths, domain-specific forbidden paths, and trusted verification argv for
   the target. An App installation is not a repository allowlist.
7. Check target CI before enabling publication. Draft PRs and App branch pushes can run workflows.
   Bot branches must use disposable runners without secrets, write tokens, privileged containers,
   or deployment access. Reina does not isolate or control external CI.
8. Provide a private persistent state directory outside the checkout. Start only one instance.

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
