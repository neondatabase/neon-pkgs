// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   none

import type { SQLQueryProps } from './common.js'

export const EXTENSIONS_SQL = (props: SQLQueryProps & { nameFilter?: string }) => /* SQL */ `
SELECT
  e.name,
  n.nspname AS schema,
  e.default_version,
  x.extversion AS installed_version,
  e.comment
FROM
  pg_available_extensions() e(name, default_version, comment)
  LEFT JOIN pg_extension x ON e.name = x.extname
  LEFT JOIN pg_namespace n ON x.extnamespace = n.oid
WHERE
  true
  ${props.nameFilter ? `AND e.name ${props.nameFilter}` : ''}
${props.limit ? `limit ${props.limit}` : ''}
${props.offset ? `offset ${props.offset}` : ''}
`
