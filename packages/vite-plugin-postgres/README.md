# ⚠️ DEPRECATED: @neondatabase/vite-plugin-postgres

**This package has been renamed to [`vite-plugin-db`](https://www.npmjs.com/package/vite-plugin-db).**

## Migration Guide

Please update your dependencies to use the new package name:

### Installation

**Before:**

```bash
npm install @neondatabase/vite-plugin-postgres
# or
pnpm add @neondatabase/vite-plugin-postgres
```

**After:**

```bash
npm install vite-plugin-db
# or
pnpm add vite-plugin-db
```

### Usage in vite.config.ts

**Before:**

```typescript
import { postgres } from "@neondatabase/vite-plugin-postgres";

export default defineConfig({
	plugins: [postgres()],
});
```

**After:**

```typescript
import { postgres } from "vite-plugin-db";

export default defineConfig({
	plugins: [postgres()],
});
```

## Why the Rename?

The package was renamed to `vite-plugin-db` to align with the CLI package rename from `neondb` to `get-db`, providing a more consistent and intuitive naming scheme.

## Support

For issues, questions, or contributions, please visit the [repository](https://github.com/neondatabase/neon-pkgs).
