// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   none

import { VERSION_SQL } from './sql/version.sql.js'
import type { PostgresMetaResult, PostgresVersion } from './types.js'

export default class PostgresMetaVersion {
  query: (sql: string) => Promise<PostgresMetaResult<any>>

  constructor(query: (sql: string) => Promise<PostgresMetaResult<any>>) {
    this.query = query
  }

  async retrieve(): Promise<PostgresMetaResult<PostgresVersion>> {
    const { data, error } = await this.query(VERSION_SQL())
    if (error) {
      return { data, error }
    }
    return { data: data[0], error }
  }
}
