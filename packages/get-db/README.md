# get-db (DEPRECATED)

**This package has been renamed to [`neon-new`](https://www.npmjs.com/package/neon-new).**

Please update your dependencies:

```diff
- "get-db": "^0.x.x"
+ "neon-new": "^0.x.x"
```

And update your imports:

```diff
- import { instantPostgres } from "get-db/sdk";
+ import { instantPostgres } from "neon-new/sdk";
```

CLI usage:

```diff
- npx get-db
+ npx neon-new
```

This package will continue to work as an alias but will show deprecation warnings.

For documentation, see the [`neon-new` README](https://github.com/neondatabase/neon-pkgs/tree/main/packages/neon-new).
