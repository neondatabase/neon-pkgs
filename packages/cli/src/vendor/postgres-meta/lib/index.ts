// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   - Slimmer re-export than upstream `src/lib/index.ts`. Exposes only the
//     types that `templates/typescript.ts` and `cli/commands/generate-types.ts`
//     consume. `PostgresMeta` itself is imported directly from
//     `./PostgresMeta.js` by callers that need it.

export type {
  PostgresColumn,
  PostgresFunction,
  PostgresSchema,
  PostgresTable,
  PostgresType,
  PostgresView,
  PostgresMaterializedView,
  PostgresForeignTable,
  PostgresRelationship,
  PostgresMetaResult,
  PostgresMetaOk,
  PostgresMetaErr,
  PoolConfig,
} from './types.js'

export { default as PostgresMeta } from './PostgresMeta.js'
