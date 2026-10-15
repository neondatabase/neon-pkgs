// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   none

export type SQLQueryProps = {
  limit?: number
  offset?: number
}

export type SQLQueryPropsWithSchemaFilter = SQLQueryProps & {
  schemaFilter?: string
}

export type SQLQueryPropsWithIdsFilter = SQLQueryProps & {
  idsFilter?: string
}

export type SQLQueryPropsWithSchemaFilterAndIdsFilter = SQLQueryProps & {
  schemaFilter?: string
  idsFilter?: string
}
