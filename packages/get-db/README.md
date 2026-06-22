# ⚠️ DEPRECATED: get-db

> **This package is deprecated and no longer maintained.** It has been renamed to
> [`neon-new`](https://www.npmjs.com/package/neon-new). It still works as an alias but prints a
> deprecation warning at runtime — please migrate.

## Migration

Update your dependency:

```diff
- "get-db": "^0.x.x"
+ "neon-new": "^0.x.x"
```

Update your imports:

```diff
- import { instantPostgres } from "get-db/sdk";
+ import { instantPostgres } from "neon-new/sdk";
```

CLI usage:

```diff
- npx get-db
+ npx neon-new
```

For documentation, see the [`neon-new` README](https://github.com/neondatabase/neon-pkgs/tree/main/packages/neon-new).
