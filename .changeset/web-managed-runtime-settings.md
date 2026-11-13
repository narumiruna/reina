---
"reina": minor
---

Add authenticated Runtime settings for GitHub App identity and webhook secret, repository and installation identity, immutable worker image, path policy, verification commands, and existing operational limits. Store the complete record encrypted in the existing settings database and return only safe metadata. Keep webhook secrets write-only and preserve them when omitted on updates.

Apply saved settings through the existing fail-closed controller reload. Saved runtime settings override legacy dispatch environment configuration; legacy values remain a fallback only before the first runtime save. Keep encryption, login, listener, and storage bootstrap settings external. Require the existing session, Origin, and CSRF checks for runtime changes. Saving can start scans and model requests but never grants coding approval.
