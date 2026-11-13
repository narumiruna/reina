---
"reina": minor
---

Publish durable read-only issue assessments with classification and a host-derived fix-candidate, needs-info, or needs-human outcome. Maintain one mutable triage summary separately from immutable fix proposals and fresh human approval. Add operator-provisioned bot:triaged, bot:needs-info, bot:needs-human, and bot:triage-failed labels; a reviewed label means confirmed assessment publication, not an attempt, verified fix, or permission to code.

Persist bounded three-attempt assessment cycles with one-minute/five-minute retries for allowed transient failures, failure suppression until evidence or policy changes, and separate 24-hour successful fix-candidate renewal. Recover publication from saved results without inference. Invalidate changed evidence, prevent own-comment/label loops, and reconcile stored reviews independently of open-issue discovery, including closed, skipped, deleted, and incomplete evidence.

Migrate job database reina.sqlite from schema 4 to 5 transactionally while preserving existing authority and work records. Encrypted settings.sqlite remains schema 3. Require consistent stopped-instance backups with WAL state and the original ENCRYPTION_KEY; downgrades require matching backups, and restoration does not undo GitHub writes. Document safe lifecycle logs, label setup, recovery, and verifier-specific external acceptance. Existing Pocket ID authorization, provider limits including the Codex upstream cap limitation, worker isolation, and production Linux runtime release gates remain in force.
