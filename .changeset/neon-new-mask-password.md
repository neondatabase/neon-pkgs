---
"neon-new": patch
---

Stop printing the database password. The CLI's closing summary now shows the pooled connection string with its password masked and names the env file and the connection-string keys it wrote; the full connection strings still go to the env file only. A `--seed` failure whose driver error quotes the connection string is rethrown with the password masked. `instantPostgres()` still returns the full connection strings.
