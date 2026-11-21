---
"neon": patch
---

When the CLI has no usable credential, `neon me` and other commands now list the ways to authenticate: sign in with `neon login`, save an API key you already have with `echo "$KEY" | neon profile create <profile> --api-key -`, or create a temporary project with `neon claim create`. `neon init -y` and a rejected profile key point at the same command. A rejected `NEON_API_KEY` now says that it overrides a saved sign-in.
