// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   none

import type { SQLQueryProps } from './common.js'

export const FOREIGN_TABLES_SQL = (
  props: SQLQueryProps & {
    schemaFilter?: string
    idsFilter?: string
    tableIdentifierFilter?: string
  }
) => /* SQL */ `
SELECT
  c.oid :: int8 AS id,
  n.nspname AS schema,
  c.relname AS name,
  obj_description(c.oid) AS comment
FROM
  pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE
  ${props.schemaFilter ? `n.nspname ${props.schemaFilter} AND` : ''}
  ${props.idsFilter ? `c.oid ${props.idsFilter} AND` : ''}
  ${props.tableIdentifierFilter ? `(n.nspname || '.' || c.relname) ${props.tableIdentifierFilter} AND` : ''}
  c.relkind = 'f'
${props.limit ? `limit ${props.limit}` : ''}
${props.offset ? `offset ${props.offset}` : ''}
`
