---
"neon": minor
"neonctl": minor
---

Add `neon api-keys`, including project-scoped keys

The CLI exposed no API-key management at all, so the only way to mint one was the console or a hand-rolled `neon api /organizations/{id}/api_keys -X POST`. All six endpoints are now covered:

```bash
neon api-keys list                                        # your account's keys
neon api-keys list --org-id org-…                         # an organization's, with scope shown

neon api-keys create --name ci                            # account key
neon api-keys create --name ci    --org-id org-…          # organization key
neon api-keys create --name agent --project-id frosty-…   # can access only that project

neon api-keys revoke <id> [--org-id org-…]
```

**Project-scoped keys are the reason this matters.** A key created with `--project-id` cannot create projects, cannot mint API keys, and cannot see any other project — other projects return "not found" rather than a permission error, so it isn't even an existence oracle. It is not read-only — inside that project it can do anything the API allows, including deleting it. What it bounds is reach, which is what lets you hand it to an agent or a CI job without handing over your account:

```bash
NEON_API_KEY=napi_… neon deploy    # applies neon.ts, and can reach nothing else
```

`--org-id` and `--project-id` are mutually exclusive: a project-scoped key is already an organization key, and its organization is looked up from the project rather than chosen separately. With neither flag you get an account key.

`api-keys` is deliberately exempt from `.neon` context enrichment. Every other project command fills `--project-id` from the linked directory, which here would mean `api-keys create --name ci` silently producing a key scoped to whatever project is checked out instead of the account key requested. How far a credential reaches comes only from a flag you typed.

`neon api-keys list --org-id` shows which keys are scoped and to what, reading `— all projects —` for keys that aren't narrowed, alongside `last_used_at` and `last_used_from_addr` — the fields you need to spot a key worth revoking.
