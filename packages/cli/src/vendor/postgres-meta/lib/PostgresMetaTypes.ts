// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   none

import { DEFAULT_SYSTEM_SCHEMAS } from './constants.js'
import { filterByList } from './helpers.js'
import type { PostgresMetaResult, PostgresType } from './types.js'
import { TYPES_SQL } from './sql/types.sql.js'

export default class PostgresMetaTypes {
  query: (sql: string) => Promise<PostgresMetaResult<any>>

  constructor(query: (sql: string) => Promise<PostgresMetaResult<any>>) {
    this.query = query
  }

  async list({
    includeTableTypes = false,
    includeArrayTypes = false,
    includeSystemSchemas = false,
    includedSchemas,
    excludedSchemas,
    limit,
    offset,
  }: {
    includeTableTypes?: boolean
    includeArrayTypes?: boolean
    includeSystemSchemas?: boolean
    includedSchemas?: string[]
    excludedSchemas?: string[]
    limit?: number
    offset?: number
  } = {}): Promise<PostgresMetaResult<PostgresType[]>> {
    const schemaFilter = filterByList(
      includedSchemas,
      excludedSchemas,
      !includeSystemSchemas ? DEFAULT_SYSTEM_SCHEMAS : undefined
    )
    const sql = TYPES_SQL({ schemaFilter, limit, offset, includeTableTypes, includeArrayTypes })
    return await this.query(sql)
  }
}
