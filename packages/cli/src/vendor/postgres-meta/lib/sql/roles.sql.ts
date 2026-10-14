// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   none

import type { SQLQueryPropsWithIdsFilter } from './common.js'

export const ROLES_SQL = (
  props: SQLQueryPropsWithIdsFilter & {
    includeDefaultRoles?: boolean
    nameFilter?: string
  }
) => /* SQL */ `
-- TODO: Consider using pg_authid vs. pg_roles for unencrypted password field
SELECT
  oid :: int8 AS id,
  rolname AS name,
  rolsuper AS is_superuser,
  rolcreatedb AS can_create_db,
  rolcreaterole AS can_create_role,
  rolinherit AS inherit_role,
  rolcanlogin AS can_login,
  rolreplication AS is_replication_role,
  rolbypassrls AS can_bypass_rls,
  (
    SELECT
      COUNT(*)
    FROM
      pg_stat_activity
    WHERE
      pg_roles.rolname = pg_stat_activity.usename
  ) AS active_connections,
  CASE WHEN rolconnlimit = -1 THEN current_setting('max_connections') :: int8
       ELSE rolconnlimit
  END AS connection_limit,
  rolpassword AS password,
  rolvaliduntil AS valid_until,
  rolconfig AS config
FROM
  pg_roles
WHERE
  ${props.idsFilter ? `oid ${props.idsFilter}` : 'true'}
  -- All default/predefined roles start with pg_: https://www.postgresql.org/docs/15/predefined-roles.html
  -- The pg_ prefix is also reserved.
  ${!props.includeDefaultRoles ? `AND NOT pg_catalog.starts_with(rolname, 'pg_')` : ''}
  ${props.nameFilter ? `AND rolname ${props.nameFilter}` : ''}
${props.limit ? `limit ${props.limit}` : ''}
${props.offset ? `offset ${props.offset}` : ''}
`
