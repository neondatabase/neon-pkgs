// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   none

import type { SQLQueryPropsWithSchemaFilterAndIdsFilter } from './common.js'

export const MATERIALIZED_VIEWS_SQL = (
  props: SQLQueryPropsWithSchemaFilterAndIdsFilter & {
    materializedViewIdentifierFilter?: string
  }
) => /* SQL */ `
select
  c.oid::int8 as id,
  n.nspname as schema,
  c.relname as name,
  c.relispopulated as is_populated,
  obj_description(c.oid) as comment
from
  pg_class c
  join pg_namespace n on n.oid = c.relnamespace
where
  ${props.schemaFilter ? `n.nspname ${props.schemaFilter} AND` : ''}
  ${props.idsFilter ? `c.oid ${props.idsFilter} AND` : ''}
  ${props.materializedViewIdentifierFilter ? `(n.nspname || '.' || c.relname) ${props.materializedViewIdentifierFilter} AND` : ''}
  c.relkind = 'm'
${props.limit ? `limit ${props.limit}` : ''}
${props.offset ? `offset ${props.offset}` : ''}
`
