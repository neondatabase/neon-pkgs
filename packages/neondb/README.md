# ⚠️ DEPRECATED: neondb

> **This package is deprecated and no longer maintained.** It has been renamed to
> [`neon-new`](https://www.npmjs.com/package/neon-new). It still works as an alias but prints a
> deprecation warning at runtime — please migrate.

> **Requirements:** Node.js >= 20.19 (same as the package it forwards to).

## Migration

Update your dependency:

```diff
- "neondb": "^0.x.x"
+ "neon-new": "^0.x.x"
```

CLI usage:

```diff
- npx neondb
+ npx neon-new
```

Update your imports:

```diff
- import { instantNeon } from "neondb/sdk";
+ import { instantNeon } from "neon-new/sdk";
```

For documentation, see the [`neon-new` README](https://github.com/neondatabase/neon-pkgs/tree/main/packages/neon-new).
