---
"reina": minor
---

Add Connect GitHub for the existing service App. Reuse accessible installations, use GitHub's official OAuth and installation screens, and let users select a verified repository without entering repository or installation IDs. Keep one-time service App setup separate from ordinary connection.

Use session-bound single-use state and OAuth PKCE. Verify App identity and GitHub user installation/repository access, then revalidate before selection. Keep user tokens in bounded server memory only and cancel stale flows on logout, expiry, shutdown, or App/key changes. Encrypt operator App credentials and verified repository bindings in the existing settings database; keep secrets write-only.

Automatically fill Runtime identity from the selected connection without granting coding approval. Require matching App/repository bindings and separate worker/policy configuration before dispatch. Keep legacy deployment compatibility and existing worker limits.

Make incomplete service setup actionable: Connect GitHub opens and focuses the missing setting. Remove accidental surrounding whitespace from pasted OAuth client secrets while rejecting empty values and embedded control characters; preserve exact webhook secrets.
