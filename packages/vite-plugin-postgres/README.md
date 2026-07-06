# ⚠️ DEPRECATED: @neondatabase/vite-plugin-postgres

> **This package is deprecated and no longer maintained.** It has been renamed to
> [`vite-plugin-neon-new`](https://www.npmjs.com/package/vite-plugin-neon-new). It still works as an
> alias but prints a deprecation warning at runtime — please migrate.

> **Requirements:** Node.js >= 20.19 (same as the package it forwards to).

## Migration

Update your dependency:

```diff
- "@neondatabase/vite-plugin-postgres": "^0.x.x"
+ "vite-plugin-neon-new": "^0.x.x"
```

Update your imports:

```diff
- import { postgres } from "@neondatabase/vite-plugin-postgres";
+ import { postgres } from "vite-plugin-neon-new";
```

For documentation, see the [`vite-plugin-neon-new` README](https://github.com/neondatabase/neon-pkgs/tree/main/packages/vite-plugin-neon-new).
