---
"@neondatabase/config": minor
"@neondatabase/config-runtime": minor
---

Stop treating the AI Gateway as a provisionable branch resource. The AI Gateway is always available on a branch — it is credential-gated, not per-branch provisioned, and has no control-plane enable/disable/status route. Declaring `preview.aiGateway` in a `neon.ts` only means "mint a branch credential scoped `ai_gateway:invoke` and surface the gateway env vars (`OPENAI_*` / `NEON_AI_GATEWAY_*`)", which `@neondatabase/env` already does without touching any AI Gateway endpoint.

Previously `plan` / `apply` / `status` (and the policy-gated `env pull`) probed `GET /projects/{p}/branches/{b}/ai-gateway` to diff an `enable-ai-gateway` step. That endpoint isn't part of the platform, so the probe failed with a `PLATFORM_FEATURE_UNAVAILABLE` error and broke commands that otherwise only needed `DATABASE_URL` / auth. Removed end to end:

- **`@neondatabase/config`** — `NeonApi` no longer declares `getAiGatewayEnabled` / `enableAiGateway` / `disableAiGateway`; the `enable-ai-gateway` `PlanStep` and `RemotePreviewState.aiGatewayEnabled` are gone, and `diffConfig` never emits an AI Gateway step. `ResolvedPreviewConfig.aiGatewayEnabled` stays — it still drives the credential scope and env vars.
- **`@neondatabase/config-runtime`** — `pushConfig` no longer probes or applies AI Gateway state, and `PulledPreview.aiGatewayEnabled` is removed from `pullConfig` / `inspect` (the gateway is not per-branch state to report).

Consumers reading `PulledPreview.aiGatewayEnabled` (e.g. a CLI `config status` view) should drop it; `preview.aiGateway` continues to work in `neon.ts` exactly as before for env resolution.
