// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   none

import { literal } from 'pg-format'

export const coalesceRowsToArray = (source: string, filter: string) => {
  return `
COALESCE(
  (
    SELECT
      array_agg(row_to_json(${source})) FILTER (WHERE ${filter})
    FROM
      ${source}
  ),
  '{}'
) AS ${source}`
}

export const filterByList = (
  include?: (string | number)[],
  exclude?: (string | number)[],
  defaultExclude?: (string | number)[]
) => {
  if (defaultExclude) {
    exclude = defaultExclude.concat(exclude ?? [])
  }
  if (include?.length) {
    return `IN (${include.map(literal).join(',')})`
  } else if (exclude?.length) {
    return `NOT IN (${exclude.map(literal).join(',')})`
  }
  return ''
}

export const filterByValue = (ids?: (string | number)[]) => {
  if (ids?.length) {
    return `IN (${ids.map(literal).join(',')})`
  }
  return ''
}
