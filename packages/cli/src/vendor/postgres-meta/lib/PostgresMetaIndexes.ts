// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   none

import { DEFAULT_SYSTEM_SCHEMAS } from './constants.js'
import { filterByList, filterByValue } from './helpers.js'
import type { PostgresMetaResult, PostgresIndex } from './types.js'
import { INDEXES_SQL } from './sql/indexes.sql.js'

export default class PostgresMetaIndexes {
  query: (sql: string) => Promise<PostgresMetaResult<any>>

  constructor(query: (sql: string) => Promise<PostgresMetaResult<any>>) {
    this.query = query
  }

  async list({
    includeSystemSchemas = false,
    includedSchemas,
    excludedSchemas,
    limit,
    offset,
  }: {
    includeSystemSchemas?: boolean
    includedSchemas?: string[]
    excludedSchemas?: string[]
    limit?: number
    offset?: number
  } = {}): Promise<PostgresMetaResult<PostgresIndex[]>> {
    const schemaFilter = filterByList(
      includedSchemas,
      excludedSchemas,
      !includeSystemSchemas ? DEFAULT_SYSTEM_SCHEMAS : undefined
    )
    const sql = INDEXES_SQL({ schemaFilter, limit, offset })
    return await this.query(sql)
  }

  async retrieve({ id }: { id: number }): Promise<PostgresMetaResult<PostgresIndex>>
  async retrieve({
    name,
    schema,
    args,
  }: {
    name: string
    schema: string
    args: string[]
  }): Promise<PostgresMetaResult<PostgresIndex>>
  async retrieve({
    id,
  }: {
    id?: number
    args?: string[]
  }): Promise<PostgresMetaResult<PostgresIndex>> {
    if (id) {
      const idsFilter = filterByValue([id])
      const sql = INDEXES_SQL({ idsFilter })
      const { data, error } = await this.query(sql)
      if (error) {
        return { data, error }
      } else if (data.length === 0) {
        return { data: null, error: { message: `Cannot find a index with ID ${id}` } }
      } else {
        return { data: data[0], error }
      }
    } else {
      return { data: null, error: { message: 'Invalid parameters on function retrieve' } }
    }
  }
}
