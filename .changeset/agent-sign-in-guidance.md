---
"neon": patch
---

When a coding agent runs the CLI without a usable credential, `neon me`, other commands, `neon login`, and `neon init -y` now say what to do next: sign in only if a browser can reach this machine's callback, otherwise use an API key the user already has or create a temporary project with `neon claim create`, and never ask the user to create a key. A rejected `NEON_API_KEY` now says that it overrides a saved sign-in.
