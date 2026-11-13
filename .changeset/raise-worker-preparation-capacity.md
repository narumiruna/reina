---
"reina": patch
---

Increase bounded dependency-preparation capacity to support larger native tooling: 64 MiB tarballs/imports, 1 GiB cumulative downloads, 128 MiB individual dependency files, 512 MiB dependency content, 576 MiB raw dependency archive reads, and 96 MiB dependency JSON input. Use a separate 2 GiB preparation workspace.

Keep ordinary 256 MiB coding workspaces, 64 MiB temporary filesystems, CPU/memory/process/network restrictions, registry and SHA512 verification, approved dependency fingerprints, lifecycle-disabled installation, archive validation, deadlines, and cleanup. Add no environment variables or feature flags.

Accept JWT-shaped installation tokens only with matching trusted issuance metadata. Keep exact token, installation, repository, expiry, and permission checks instead of relying on the SDK's token-format classification.

Support Codex SSE responses with an omitted Content-Type header while retaining event, byte, deadline, and origin validation. Reject incorrect MIME types and keep other APIs strict. Remove setup-profile networks during Compose fixture cleanup.
