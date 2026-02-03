# neon-init

Set up Neon for AI-powered database operations in VS Code, Cursor, and Claude CLI.

## Installation

```sh
npm add neon-init
```

## Usage

```ts
import { init } from "neon-init";

await init();
```

Or via CLI:

```sh
npx neon-init
```

Then:

1. Restart your editor (VS Code, Cursor, or Claude CLI)
2. Type **"Get started with Neon"** in your AI chat

## What It Does

### For VS Code and Cursor: Installs Neon Local Connect Extension (which includes the Neon MCP Server)

-   Automatically installs the `databricks.neon-local-connect` extension
-   Uses the editor's CLI (`code --install-extension` or `cursor --install-extension`)
-   Configures the API key automatically via URI handler
-   Provides local database development capabilities directly in your editor
-   Allows management of your MCP server within the extension

### For Claude CLI: Configures Neon MCP Server

-   Creates or updates `~/.claude.json` (global config - works across all projects)
-   Configures remote MCP server with API key authentication
-   Provides AI-powered database operations via MCP protocol

**Supported Editors:**

-   **VS Code** (uses Neon Local Connect extension)
-   **Cursor** (uses Neon Local Connect extension)
-   **Claude CLI** (uses MCP Server)

The tool automatically detects which editors are installed on your system and you'll be prompted to choose which one(s) to configure.

**Authentication:** Uses OAuth via `neonctl` and creates an API key for you - opens your browser, no manual API keys needed.

**Agent Guidelines:** The Neon MCP Server includes built-in agent guidelines as an MCP resource. Your AI assistant will automatically have access to:

-   Interactive "Get started with Neon" onboarding flow
-   Security, performance, and schema management best practices
-   Neon-specific features (branching, autoscaling, scale-to-zero)

### Installs Neon Agent Skills
After configuring your editor, `neon-init` automatically installs the `neon-postgres` skill using Vercel's [skills ecosystem](https://skills.sh). This enhances your agent with Neon-specific Postgres capabilities and commands.

-   Runs `npx skills add neondatabase/agent-skills --skill neon-postgres` for each selected editor
-   Auto-confirms installation with `-y` flag
-   Maps editors to agent names: Cursor → `cursor`, VS Code → `github-copilot`, Claude CLI → `claude-code`

## Development

| Command                         | Description                    |
| ------------------------------- | ------------------------------ |
| `pnpm build`                    | Build the package              |
| `pnpm tsx src/cli.ts`           | Run CLI locally (no build)     |
| `node dist/cli.js`              | Run built CLI                  |

### From workspace root

| Command                         | Description       |
| ------------------------------- | ----------------- |
| `pnpm --filter neon-init build` | Build the package |
| `pnpm --filter neon-init test`  | Run the tests     |
