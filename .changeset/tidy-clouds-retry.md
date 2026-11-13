---
"@neon/realtime": patch
---

Back off failed capability refreshes and subscription renewals with jitter, up to a 30-second retry window. Reset the delay after a successful renewal so temporary authorization or transport outages recover without synchronized retry traffic.
