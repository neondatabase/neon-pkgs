---
"neon": patch
---

`neon inspect db locks` and `neon inspect db long-running-queries` now report only the database being inspected. Both read compute-wide views, so they previously listed sessions in other databases on the same branch — and because a lock's relation OID only means something in its own database, `locks` resolved those names against the wrong catalog and printed an empty relation name, or a different table that happened to share the OID.
