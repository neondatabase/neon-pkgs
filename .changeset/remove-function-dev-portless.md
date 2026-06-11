---
"@neondatabase/config": minor
---

Remove the `dev.portless` option from a function's `dev` block. `neon dev` no longer wraps functions with the external `portless` proxy: that required a separately-installed global `portless` binary and only produced a clean `slug.localhost` URL behind a privileged (port 80/443) proxy — otherwise the URL still carried a proxy port (e.g. `:1355`), which defeats the purpose. The `dev` block now supports only `dev.port`; functions serve on a plain `http://localhost:<port>` (an explicit `dev.port`, or an auto-selected free port when omitted).
