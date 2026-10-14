// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   - dropped `import * as Parser from './Parser.js'` and the
//     `parse` / `deparse` / `format` field assignments. The Parser depends on
//     `pgsql-parser` + `prettier-plugin-sql`, which we do not vendor; the
//     CLI's `generateTypes` path never calls those methods.

import PostgresMetaColumnPrivileges from './PostgresMetaColumnPrivileges.js'
import PostgresMetaColumns from './PostgresMetaColumns.js'
import PostgresMetaConfig from './PostgresMetaConfig.js'
import PostgresMetaExtensions from './PostgresMetaExtensions.js'
import PostgresMetaForeignTables from './PostgresMetaForeignTables.js'
import PostgresMetaFunctions from './PostgresMetaFunctions.js'
import PostgresMetaIndexes from './PostgresMetaIndexes.js'
import PostgresMetaMaterializedViews from './PostgresMetaMaterializedViews.js'
import PostgresMetaPolicies from './PostgresMetaPolicies.js'
import PostgresMetaPublications from './PostgresMetaPublications.js'
import PostgresMetaRelationships from './PostgresMetaRelationships.js'
import PostgresMetaRoles from './PostgresMetaRoles.js'
import PostgresMetaSchemas from './PostgresMetaSchemas.js'
import PostgresMetaTablePrivileges from './PostgresMetaTablePrivileges.js'
import PostgresMetaTables from './PostgresMetaTables.js'
import PostgresMetaTriggers from './PostgresMetaTriggers.js'
import PostgresMetaTypes from './PostgresMetaTypes.js'
import PostgresMetaVersion from './PostgresMetaVersion.js'
import PostgresMetaViews from './PostgresMetaViews.js'
import { init } from './db.js'
import type { PostgresMetaResult, PoolConfig } from './types.js'

export default class PostgresMeta {
  query: (
    sql: string,
    opts?: { statementQueryTimeout?: number; trackQueryInSentry?: boolean; parameters?: unknown[] }
  ) => Promise<PostgresMetaResult<any>>
  end: () => Promise<void>
  columnPrivileges: PostgresMetaColumnPrivileges
  columns: PostgresMetaColumns
  config: PostgresMetaConfig
  extensions: PostgresMetaExtensions
  foreignTables: PostgresMetaForeignTables
  functions: PostgresMetaFunctions
  indexes: PostgresMetaIndexes
  materializedViews: PostgresMetaMaterializedViews
  policies: PostgresMetaPolicies
  publications: PostgresMetaPublications
  relationships: PostgresMetaRelationships
  roles: PostgresMetaRoles
  schemas: PostgresMetaSchemas
  tablePrivileges: PostgresMetaTablePrivileges
  tables: PostgresMetaTables
  triggers: PostgresMetaTriggers
  types: PostgresMetaTypes
  version: PostgresMetaVersion
  views: PostgresMetaViews

  constructor(config: PoolConfig) {
    const { query, end } = init(config)
    this.query = query
    this.end = end
    this.columnPrivileges = new PostgresMetaColumnPrivileges(this.query)
    this.columns = new PostgresMetaColumns(this.query)
    this.config = new PostgresMetaConfig(this.query)
    this.extensions = new PostgresMetaExtensions(this.query)
    this.foreignTables = new PostgresMetaForeignTables(this.query)
    this.functions = new PostgresMetaFunctions(this.query)
    this.indexes = new PostgresMetaIndexes(this.query)
    this.materializedViews = new PostgresMetaMaterializedViews(this.query)
    this.policies = new PostgresMetaPolicies(this.query)
    this.publications = new PostgresMetaPublications(this.query)
    this.relationships = new PostgresMetaRelationships(this.query)
    this.roles = new PostgresMetaRoles(this.query)
    this.schemas = new PostgresMetaSchemas(this.query)
    this.tablePrivileges = new PostgresMetaTablePrivileges(this.query)
    this.tables = new PostgresMetaTables(this.query)
    this.triggers = new PostgresMetaTriggers(this.query)
    this.types = new PostgresMetaTypes(this.query)
    this.version = new PostgresMetaVersion(this.query)
    this.views = new PostgresMetaViews(this.query)
  }
}
