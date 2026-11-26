---
"@neon/tools": patch
"@neon/sdk": minor
---

SQL tools now name the reason when the SQL endpoint sends no response (for example `ECONNRESET`) and keep the `fetch` failure as `cause`; `database.inspect` no longer reports this as an `InspectDiagnosticError`. `@neon/sdk` exports `describeTransportFailure`.
