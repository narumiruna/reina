---
"reina": patch
---

Make failure logs visible without exposing private request or error data. Record original job failures before label updates, use error severity for failures, and keep expected cancellation and deferral events at info severity. Log failed runtime cleanup, preserve explicitly allowed startup reason codes, and record unexpected HTTP failures with safe method, route, and status fields.
