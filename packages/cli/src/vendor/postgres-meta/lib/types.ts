// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   - rewrote every `Type.Object(...) + Static<typeof ...>` pair as a plain
//     TypeScript `interface` / discriminated union. This drops the
//     `@sinclair/typebox` runtime dependency. The schema constants
//     (`postgresColumnSchema`, etc.) were never imported by anything we
//     vendor — they only existed to feed Fastify route validators in the
//     upstream HTTP server, which we do not vendor.
//   - replaced the `pg-protocol` `DatabaseError` type import with a minimal
//     structural alias that captures the fields the rest of the vendored
//     code reads. `pg-protocol` is bundled with `pg`, but we keep the
//     direct dependency surface to upstream `pg@^8` only.

import type { Options as PrettierOptions } from 'prettier'
import type { PoolConfig as PgPoolConfig } from 'pg'

// Structural shape of `pg-protocol`'s `DatabaseError`. We only need the
// fields the rest of the vendored code touches.
interface PgDatabaseError extends Error {
  length?: number
  severity?: string
  code?: string
  detail?: string
  hint?: string
  position?: string
  internalPosition?: string
  internalQuery?: string
  where?: string
  schema?: string
  table?: string
  column?: string
  dataType?: string
  constraint?: string
  file?: string
  line?: string
  routine?: string
}

export interface FormatterOptions extends PrettierOptions {}

export interface PostgresMetaOk<T> {
  data: T
  error: null
}

export interface PostgresMetaErr {
  data: null
  error: Partial<PgDatabaseError> & { message: string; formattedError?: string }
}

export type PostgresMetaResult<T> = PostgresMetaOk<T> | PostgresMetaErr

export interface PostgresColumn {
  table_id: number
  schema: string
  table: string
  /** Matches `^(\d+)\.(\d+)$` */
  id: string
  ordinal_position: number
  name: string
  default_value: unknown
  data_type: string
  format: string
  is_identity: boolean
  identity_generation: 'ALWAYS' | 'BY DEFAULT' | null
  is_generated: boolean
  is_nullable: boolean
  is_updatable: boolean
  is_unique: boolean
  enums: string[]
  check: string | null
  comment: string | null
}

export interface PostgresColumnCreate {
  table_id: number
  name: string
  type: string
  default_value?: unknown
  default_value_format?: 'expression' | 'literal'
  is_identity?: boolean
  identity_generation?: 'BY DEFAULT' | 'ALWAYS'
  is_nullable?: boolean
  is_primary_key?: boolean
  is_unique?: boolean
  comment?: string
  check?: string
}

export interface PostgresColumnUpdate {
  name?: string
  type?: string
  drop_default?: boolean
  default_value?: unknown
  default_value_format?: 'expression' | 'literal'
  is_identity?: boolean
  identity_generation?: 'BY DEFAULT' | 'ALWAYS'
  is_nullable?: boolean
  is_unique?: boolean
  comment?: string
  check?: string | null
}

// TODO Rethink config.sql
export interface PostgresConfig {
  name: unknown
  setting: unknown
  category: unknown
  group: unknown
  subgroup: unknown
  unit: unknown
  short_desc: unknown
  extra_desc: unknown
  context: unknown
  vartype: unknown
  source: unknown
  min_val: unknown
  max_val: unknown
  enumvals: unknown
  boot_val: unknown
  reset_val: unknown
  sourcefile: unknown
  sourceline: unknown
  pending_restart: unknown
}

export interface PostgresExtension {
  name: string
  schema: string | null
  default_version: string
  installed_version: string | null
  comment: string | null
}

export interface PostgresForeignTable {
  id: number
  schema: string
  name: string
  comment: string | null
  columns?: PostgresColumn[]
}

export interface PostgresFunction {
  id: number
  schema: string
  name: string
  language: string
  definition: string
  complete_statement: string
  args: {
    mode: 'in' | 'out' | 'inout' | 'variadic' | 'table'
    name: string
    type_id: number
    has_default: boolean
  }[]
  argument_types: string
  identity_argument_types: string
  return_type_id: number
  return_type: string
  return_type_relation_id: number | null
  is_set_returning_function: boolean
  prorows: number | null
  behavior: 'IMMUTABLE' | 'STABLE' | 'VOLATILE'
  security_definer: boolean
  config_params: Record<string, string> | null
}

export interface PostgresFunctionCreate {
  name: string
  definition: string
  args?: string[]
  behavior?: 'IMMUTABLE' | 'STABLE' | 'VOLATILE'
  config_params?: Record<string, string>
  schema?: string
  language?: string
  return_type?: string
  security_definer?: boolean
}

export interface PostgresIndex {
  id: number
  table_id: number
  schema: string
  number_of_attributes: number
  number_of_key_attributes: number
  is_unique: boolean
  is_primary: boolean
  is_exclusion: boolean
  is_immediate: boolean
  is_clustered: boolean
  is_valid: boolean
  check_xmin: boolean
  is_ready: boolean
  is_live: boolean
  is_replica_identity: boolean
  key_attributes: number[]
  collation: number[]
  class: number[]
  options: number[]
  index_predicate: string | null
  comment: string | null
  index_definition: string
  access_method: string
  index_attributes: {
    attribute_number: number
    attribute_name: string
    data_type: string
  }[]
}

export interface PostgresPolicy {
  id: number
  schema: string
  table: string
  table_id: number
  name: string
  action: 'PERMISSIVE' | 'RESTRICTIVE'
  roles: string[]
  command: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL'
  definition: string | null
  check: string | null
}

export interface PostgresPrimaryKey {
  schema: string
  table_name: string
  name: string
  table_id: number
}

export interface PostgresPublication {
  id: number
  name: string
  owner: string
  publish_insert: boolean
  publish_update: boolean
  publish_delete: boolean
  publish_truncate: boolean
  tables: { id: number; name: string; schema: string }[] | null
}

/** Older shape returned by the `relationships` SQL; kept for compatibility. */
export interface PostgresRelationshipOld {
  id: number
  constraint_name: string
  source_schema: string
  source_table_name: string
  source_column_name: string
  target_table_schema: string
  target_table_name: string
  target_column_name: string
}

export interface PostgresRelationship {
  foreign_key_name: string
  schema: string
  relation: string
  columns: string[]
  is_one_to_one: boolean
  referenced_schema: string
  referenced_relation: string
  referenced_columns: string[]
}

export interface PostgresMetaRoleConfig {
  op: 'remove' | 'add' | 'replace'
  path: string
  value?: string
}

export interface PostgresRole {
  id: number
  name: string
  is_superuser: boolean
  can_create_db: boolean
  can_create_role: boolean
  inherit_role: boolean
  can_login: boolean
  is_replication_role: boolean
  can_bypass_rls: boolean
  active_connections: number
  connection_limit: number
  password: string
  valid_until: string | null
  config: string | null | Record<string, string>
}

export interface PostgresRoleCreate {
  name: string
  password?: string
  inherit_role?: boolean
  can_login?: boolean
  is_superuser?: boolean
  can_create_db?: boolean
  can_create_role?: boolean
  is_replication_role?: boolean
  can_bypass_rls?: boolean
  connection_limit?: number
  member_of?: string[]
  members?: string[]
  admins?: string[]
  valid_until?: string
  config?: Record<string, string>
}

export interface PostgresRoleUpdate {
  name?: string
  password?: string
  inherit_role?: boolean
  can_login?: boolean
  is_superuser?: boolean
  can_create_db?: boolean
  can_create_role?: boolean
  is_replication_role?: boolean
  can_bypass_rls?: boolean
  connection_limit?: number
  valid_until?: string
  config?: PostgresMetaRoleConfig[]
}

export interface PostgresSchema {
  id: number
  name: string
  owner: string
}

export interface PostgresSchemaCreate {
  name: string
  owner?: string
}

export interface PostgresSchemaUpdate {
  name?: string
  owner?: string
}

export interface PostgresTable {
  id: number
  schema: string
  name: string
  rls_enabled: boolean
  rls_forced: boolean
  replica_identity: 'DEFAULT' | 'INDEX' | 'FULL' | 'NOTHING'
  bytes: number
  size: string
  live_rows_estimate: number
  dead_rows_estimate: number
  comment: string | null
  columns?: PostgresColumn[]
  primary_keys: PostgresPrimaryKey[]
  relationships: PostgresRelationshipOld[]
}

export interface PostgresTableCreate {
  name: string
  schema?: string
  comment?: string
}

export interface PostgresTableUpdate {
  name?: string
  schema?: string
  rls_enabled?: boolean
  rls_forced?: boolean
  replica_identity?: 'DEFAULT' | 'INDEX' | 'FULL' | 'NOTHING'
  replica_identity_index?: string
  primary_keys?: { name: string }[]
  comment?: string
}

export interface PostgresTrigger {
  id: number
  table_id: number
  enabled_mode: 'ORIGIN' | 'REPLICA' | 'ALWAYS' | 'DISABLED'
  name: string
  table: string
  schema: string
  condition: string | null
  orientation: 'ROW' | 'STATEMENT'
  activation: 'BEFORE' | 'AFTER' | 'INSTEAD OF'
  events: string[]
  function_schema: string
  function_name: string
  function_args: string[]
}

export interface PostgresType {
  id: number
  name: string
  schema: string
  format: string
  enums: string[]
  attributes: { name: string; type_id: number }[]
  comment: string | null
  type_relation_id: number | null
}

export interface PostgresVersion {
  version: string
  version_number: number
  active_connections: number
  max_connections: number
}

export interface PostgresView {
  id: number
  schema: string
  name: string
  is_updatable: boolean
  comment: string | null
  columns?: PostgresColumn[]
}

export interface PostgresMaterializedView {
  id: number
  schema: string
  name: string
  is_populated: boolean
  comment: string | null
  columns?: PostgresColumn[]
}

export interface PostgresTablePrivileges {
  relation_id: number
  schema: string
  name: string
  kind: 'table' | 'view' | 'materialized_view' | 'foreign_table' | 'partitioned_table'
  privileges: {
    grantor: string
    grantee: string
    privilege_type:
      | 'SELECT'
      | 'INSERT'
      | 'UPDATE'
      | 'DELETE'
      | 'TRUNCATE'
      | 'REFERENCES'
      | 'TRIGGER'
      | 'MAINTAIN'
    is_grantable: boolean
  }[]
}

export interface PostgresTablePrivilegesGrant {
  relation_id: number
  grantee: string
  privilege_type:
    | 'ALL'
    | 'SELECT'
    | 'INSERT'
    | 'UPDATE'
    | 'DELETE'
    | 'TRUNCATE'
    | 'REFERENCES'
    | 'TRIGGER'
    | 'MAINTAIN'
  is_grantable?: boolean
}

export interface PostgresTablePrivilegesRevoke {
  relation_id: number
  grantee: string
  privilege_type:
    | 'ALL'
    | 'SELECT'
    | 'INSERT'
    | 'UPDATE'
    | 'DELETE'
    | 'TRUNCATE'
    | 'REFERENCES'
    | 'TRIGGER'
    | 'MAINTAIN'
}

export interface PostgresColumnPrivileges {
  /** Matches `^(\d+)\.(\d+)$` */
  column_id: string
  relation_schema: string
  relation_name: string
  column_name: string
  privileges: {
    grantor: string
    grantee: string
    privilege_type: 'SELECT' | 'INSERT' | 'UPDATE' | 'REFERENCES'
    is_grantable: boolean
  }[]
}

export interface PostgresColumnPrivilegesGrant {
  /** Matches `^(\d+)\.(\d+)$` */
  column_id: string
  grantee: string
  privilege_type: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'REFERENCES'
  is_grantable?: boolean
}

export interface PostgresColumnPrivilegesRevoke {
  /** Matches `^(\d+)\.(\d+)$` */
  column_id: string
  grantee: string
  privilege_type: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'REFERENCES'
}

export interface PoolConfig extends PgPoolConfig {
  maxResultSize?: number
}
