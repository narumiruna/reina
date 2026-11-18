---
"reina": minor
---

Run initial issue triage at most once and require a fresh permitted human request
for later assessments, including after failure or expiry. Add the one-shot
`bot:retriage` read-only trigger with durable admission, replay protection, and
cleanup intent. Preserve publication repair and separate coding approval. Job
state migrates conservatively to schema 7; uncertain legacy issues need an
explicit request instead of automatic inference.
