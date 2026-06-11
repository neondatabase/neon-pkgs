---
"@neondatabase/env": patch
---

Fix the AI Gateway env URL and add `NEON_AI_GATEWAY_*` vars.

`fetchEnv` / `env pull` built `OPENAI_BASE_URL` from the **control-plane API origin** (`<NEON_API_HOST>/ai-gateway/openai/v1`), which doesn't serve the gateway (returns 403/CSRF from the console). The AI Gateway is a **branch-scoped host** (`<branchId>-api.ai.<region>.…`).

- `OPENAI_BASE_URL` is now derived from the branch's Postgres connection host (`<branchId>-api.ai.<region>.<cloud>.neon.<tld>/ai-gateway/openai/v1`), dropping any infra cell prefix.
- `env pull` additionally emits the Neon-branded aliases alongside the OpenAI ones:
  - `NEON_AI_GATEWAY_TOKEN` — the credential bearer (same value as `OPENAI_API_KEY`).
  - `NEON_AI_GATEWAY_BASE_URL` — the provider-neutral gateway root (`…/ai-gateway`) for the `anthropic` / `gemini` / `mlflow` routes.
