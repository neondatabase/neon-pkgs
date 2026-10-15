// Vendored from https://github.com/supabase/postgres-meta @ v0.93.1
//   (commit dc50199ca163b32ba4bdfa601dd3a9076ed2b640)
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) Supabase Inc. — see ../LICENSE
// Modified by Neon for vendoring purposes, 2026-04-30:
//   - removed `@sentry/node` import + every `Sentry.startSpan(...)` wrapper
//     (the CLI does not init a Sentry SDK, so the wrappers were no-ops)
//   - dropped the `RESULT_SIZE_EXCEEDED` branch (specific to the
//     `npm:@supabase/pg@0.0.3` fork; we use upstream `pg@^8`)
//   - swapped fork-specific `pg` usage for upstream `pg@^8`
//   - added `as any` casts for the raw-OID `setTypeParser` calls so they
//     compile under upstream `pg@^8`'s stricter `TypeId` overload typings
//   - converted type-only imports to `import type` for the package's
//     `verbatimModuleSyntax: true` tsconfig

import pg from 'pg'
import { parse as parseArray } from 'postgres-array'
import type { PostgresMetaResult, PoolConfig } from './types.js'

pg.types.setTypeParser(pg.types.builtins.INT8, (x) => {
  const asNumber = Number(x)
  if (Number.isSafeInteger(asNumber)) {
    return asNumber
  } else {
    return x
  }
})
pg.types.setTypeParser(pg.types.builtins.DATE, (x) => x)
pg.types.setTypeParser(pg.types.builtins.INTERVAL, (x) => x)
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (x) => x)
pg.types.setTypeParser(pg.types.builtins.TIMESTAMPTZ, (x) => x)
// `pg`'s `setTypeParser` overload signature accepts only a `TypeId` enum value
// for the strongly-typed form. We pass raw OIDs for the non-builtin array
// types, so cast to `any` to bypass the overload check. Behaviour at runtime
// is identical to the upstream call.
pg.types.setTypeParser(1115 as any, parseArray) // _timestamp
pg.types.setTypeParser(1182 as any, parseArray) // _date
pg.types.setTypeParser(1185 as any, parseArray) // _timestamptz
pg.types.setTypeParser(600 as any, (x) => x) // point
pg.types.setTypeParser(1017 as any, (x) => x) // _point

// Ensure any query will have an appropriate error handler on the pool to prevent connections errors
// to bubble up all the stack eventually killing the server
const poolerQueryHandleError = (
  pgpool: pg.Pool,
  sql: string,
  parameters?: unknown[]
): Promise<pg.QueryResult<any>> => {
  return new Promise((resolve, reject) => {
    let rejected = false
    const connectionErrorHandler = (err: any) => {
      // If the error hasn't already be propagated to the catch
      if (!rejected) {
        // Wait for the next tick so handled errors take over other stream errors
        // such as `unexpected commandComplete message`
        setTimeout(() => {
          rejected = true
          return reject(err)
        })
      }
    }
    // This listener avoids uncaught exceptions for errors happening at connection level
    // within the stream (e.g. parse errors); handle the error gracefully by bubbling it up.
    pgpool.once('error', connectionErrorHandler)
    pgpool
      .query(sql, parameters)
      .then((results: pg.QueryResult<any>) => {
        if (!rejected) {
          return resolve(results)
        }
      })
      .catch((err: any) => {
        // If the error hasn't already be handled within the error listener
        if (!rejected) {
          rejected = true
          return reject(err)
        }
      })
  })
}

export const init: (config: PoolConfig) => {
  query: (
    sql: string,
    opts?: { statementQueryTimeout?: number; trackQueryInSentry?: boolean; parameters?: unknown[] }
  ) => Promise<PostgresMetaResult<any>>
  end: () => Promise<void>
} = (config) => {
  // node-postgres ignores config.ssl if any of sslmode, sslca, sslkey, sslcert,
  // sslrootcert are in the connection string. Here we allow setting sslmode in
  // the connection string while setting the rest in config.ssl.
  if (config.connectionString) {
    const u = new URL(config.connectionString)
    const sslmode = u.searchParams.get('sslmode')
    u.searchParams.delete('sslmode')
    // For now, we don't support setting these from the connection string.
    u.searchParams.delete('sslca')
    u.searchParams.delete('sslkey')
    u.searchParams.delete('sslcert')
    u.searchParams.delete('sslrootcert')
    config.connectionString = u.toString()

    // sslmode:    null, 'disable', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify'
    // config.ssl: true, false, {}
    if (sslmode === null) {
      // skip
    } else if (sslmode === 'disable') {
      config.ssl = false
    } else {
      if (typeof config.ssl !== 'object') {
        config.ssl = {}
      }
      config.ssl.rejectUnauthorized = sslmode === 'verify-full'
    }
  }

  // NOTE: Race condition could happen here: one async task may be doing
  // `pool.end()` which invalidates the pool and subsequently all existing
  // handles to `query`. Normally you might only deal with one DB so you don't
  // need to call `pool.end()`, but since the server needs this, we make a
  // compromise: if we run `query` after `pool.end()` is called (i.e. pool is
  // `null`), we temporarily create a pool and close it right after.
  let pool: pg.Pool | null = new pg.Pool(config)

  return {
    async query(sql, { statementQueryTimeout, parameters } = {}) {
      // Use statement_timeout AND idle_session_timeout to ensure the connection will be killed even if idle after
      // timeout time.
      const statementTimeoutQueryPrefix = statementQueryTimeout
        ? `SET statement_timeout='${statementQueryTimeout}s'; SET idle_session_timeout='${statementQueryTimeout}s';`
        : ''
      // node-postgres need a statement_timeout to kill the connection when timeout is reached
      // otherwise the query will keep running on the database even if query timeout was reached
      // This need to be added at query and not connection level because poolers (pgbouncer) doesn't
      // allow to set this parameter at connection time
      const sqlWithStatementTimeout = `${statementTimeoutQueryPrefix}${sql}`
      try {
        if (!pool) {
          const transientPool = new pg.Pool(config)
          let res = await poolerQueryHandleError(transientPool, sqlWithStatementTimeout, parameters)
          if (Array.isArray(res)) {
            res = res.reverse().find((x) => x.rows.length !== 0) ?? { rows: [] }
          }
          await transientPool.end()
          return { data: res.rows, error: null }
        }

        let res = await poolerQueryHandleError(pool, sqlWithStatementTimeout, parameters)
        if (Array.isArray(res)) {
          res = res.reverse().find((x) => x.rows.length !== 0) ?? { rows: [] }
        }
        return { data: res.rows, error: null }
      } catch (error: any) {
        if (error.constructor.name === 'DatabaseError') {
          // Roughly based on:
          // - https://github.com/postgres/postgres/blob/fc4089f3c65a5f1b413a3299ba02b66a8e5e37d0/src/interfaces/libpq/fe-protocol3.c#L1018
          // - https://github.com/brianc/node-postgres/blob/b1a8947738ce0af004cb926f79829bb2abc64aa6/packages/pg/lib/native/query.js#L33
          let formattedError = ''
          {
            if (error.severity) {
              formattedError += `${error.severity}:  `
            }
            if (error.code) {
              formattedError += `${error.code}: `
            }
            if (error.message) {
              formattedError += error.message
            }
            formattedError += '\n'
            if (error.position) {
              // error.position is 1-based
              // we also remove our `SET statement_timeout = 'XXs';\n` from the position
              const position = Number(error.position) - 1 - statementTimeoutQueryPrefix.length
              // we set the new error position
              error.position = `${position + 1}`

              let line = ''
              let lineNumber = 0
              let lineOffset = 0

              const lines = sql.split('\n')
              let currentOffset = 0
              for (let i = 0; i < lines.length; i++) {
                if (currentOffset + lines[i].length > position) {
                  line = lines[i]
                  lineNumber = i + 1 // 1-based
                  lineOffset = position - currentOffset
                  break
                }
                currentOffset += lines[i].length + 1 // 1 extra offset for newline
              }
              formattedError += `LINE ${lineNumber}: ${line}\n${' '.repeat(5 + lineNumber.toString().length + 2 + lineOffset)}^\n`
            }
            if (error.detail) {
              formattedError += `DETAIL:  ${error.detail}\n`
            }
            if (error.hint) {
              formattedError += `HINT:  ${error.hint}\n`
            }
            if (error.internalQuery) {
              formattedError += `QUERY:  ${error.internalQuery}\n`
            }
            if (error.where) {
              formattedError += `CONTEXT:  ${error.where}\n`
            }
          }

          return {
            data: null,
            error: {
              ...error,
              // error.message is non-enumerable
              message: error.message,
              formattedError,
            },
          }
        }
        try {
          return { data: null, error: { code: error.code, message: error.message } }
        } finally {
          try {
            // If the error isn't a "DatabaseError" assume it's a connection related we kill the connection
            // To attempt a clean reconnect on next try
            await this.end.bind(this)
          } catch (_endError) {
            console.error('Failed to end the connection on error: ', {
              this: this,
              end: this.end,
            })
          }
        }
      }
    },

    async end() {
      try {
        const _pool = pool
        pool = null
        // Gracefully wait for active connections to be idle, then close all
        // connections in the pool.
        if (_pool) {
          await _pool.end()
        }
      } catch (endError) {
        // Ignore any errors during cleanup just log them
        console.error('Failed ending connection pool', endError)
      }
    },
  }
}
