// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   none

export const VERSION_SQL = () => /* SQL */ `
SELECT
  version(),
  current_setting('server_version_num') :: int8 AS version_number,
  (
    SELECT
      COUNT(*) AS active_connections
    FROM
      pg_stat_activity
  ) AS active_connections,
  current_setting('max_connections') :: int8 AS max_connections
`
