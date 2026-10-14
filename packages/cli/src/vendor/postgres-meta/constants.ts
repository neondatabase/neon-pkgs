// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ./LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   - This file is a slim subset of upstream's `src/server/constants.ts`.
//     It contains only the three values imported by `templates/typescript.ts`.
//     The rest of upstream's `server/constants.ts` configures a Fastify HTTP
//     server we do not vendor and pulls in `crypto-js` and a `getSecret`
//     loader, neither of which we want.

export const GENERATE_TYPES_DEFAULT_SCHEMA =
  process.env.PG_META_GENERATE_TYPES_DEFAULT_SCHEMA || 'public'

export const VALID_UNNAMED_FUNCTION_ARG_TYPES = new Set([114, 3802, 25])
export const VALID_FUNCTION_ARGS_MODE = new Set(['in', 'inout', 'variadic'])
