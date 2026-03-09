# ⚠️ DEPRECATED: neondb

**This package has been renamed to [`get-db`](https://www.npmjs.com/package/get-db).**

## Migration Guide

Please update your dependencies to use the new package name:

### CLI Usage

**Before:**

```bash
npm install -g neondb
neondb
```

**After:**

```bash
npm install -g get-db
get-db
```

### Programmatic Usage

**Before:**

```javascript
import { instantNeon } from "neondb/sdk";
```

**After:**

```javascript
import { instantNeon } from "get-db/sdk";
```

### Vite Plugin

The Vite plugin package (`@neondatabase/vite-plugin-postgres`) has been updated to use `get-db` internally. Make sure to update to the latest version.

## Why the Rename?

The package was renamed to `get-db` to better reflect its purpose and improve discoverability.

## Support

For issues, questions, or contributions, please visit the [get-db repository](https://github.com/neondatabase/neon-pkgs).
