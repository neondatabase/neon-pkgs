# neon-init

## 0.13.1

### Patch Changes

- d839446: Allow skill installs from neon init to be reported to skills.sh , so installations count as executions on the skills ecosystem. User's own DISABLE_TELEMETRY env is still respected.

## 0.13.0

### Minor Changes

- a57e18a: Add `--agent` / `-a` flag to configure a single agent without the editor selection prompt. Accepts `cursor`, `copilot`, or `claude` (and common aliases like `Cursor`, `VS Code`, `Claude CLI`).

## 0.12.1

### Patch Changes

- 9c45079: Install only the neon-postgres skill specifically using the --skill flag instead of installing all skills from neondatabase/agent-skills

## 0.12.0

### Minor Changes

- 561e679: Add automatic installation of Neon agent skills via Vercel's skills CLI. The init command now runs `npx skills add neondatabase/agent-skills` for each configured editor.

## 0.11.1

### Patch Changes

- 52537ed: Fix Node.js v24 compatibility by updating engine requirement from `"22"` to `">=22"`

## 0.11.0

### Minor Changes

- 0f641cf: Install Neon Local Connect extension for VS Code and Cursor instead of MCP Server.

  - VS Code and Cursor now use the Neon Local Connect extension for local database development
  - Claude CLI continues to use the MCP Server
  - Extension is automatically installed via CLI with robust path detection (checks known installation paths, uses mdfind on macOS)
  - API key is automatically configured via extension URI handler
  - Falls back to showing marketplace links if CLI installation fails

## 0.10.1

### Patch Changes

- 0f3cc14: Update init output message to "Get started with Neon" instead of "Get started with Neon using MCP resource"

## 0.10.0

### Minor Changes

- cc3eff2: Add support for VS Code and Claude CLI in addition to Cursor. The CLI now:

  - Automatically detects which editors are installed on your system
  - Allows you to select and configure multiple editors at once
  - Supports VS Code with global (or workspace-level as a fallback) MCP configuration
  - Supports Claude CLI with global MCP configuration

## 0.9.1

### Patch Changes

- 5430282: Fix instructions to ensure MCP resources are detected by prompting users to restart Cursor after MCP server installation. The newly installed MCP server occasionally didn't detect the MCP resources without a restart.

## 0.9.0

### Minor Changes

- 0174963: **Agent guidelines now served via MCP resource**

  Removed AGENTS.md and .neon/AGENTS.md file creation logic. Agent guidelines are now provided directly by the Neon MCP Server as an MCP resource, eliminating the need to create local files in user projects.

  Changes:

  - Removed functions for creating AGENTS.md and .neon/AGENTS.md files
  - Removed organization fetching and selection (no longer needed for local files)
  - Simplified the CLI flow to only configure the MCP server
  - Updated README to reflect that guidelines are built into the MCP server
  - Reduced bundle size by ~19%

  Users should now use "Get started with Neon using MCP Resource" to access the interactive onboarding flow.

## 0.8.1

### Patch Changes

- c745c8e: Improve agents template with better guidance for .env handling and database driver setup:

  - Add explicit safeguards to prevent accidental .env file overwrites when files are in ignore lists
  - Require LLMs to read .env before modifying it and use append commands when files are unreadable
  - Update established project guidance to automatically integrate installed drivers with existing code
  - Clean up output during authentication flow based on user feedback

## 0.8.0

### Minor Changes

- aeefc80: Consolidate CLI output and other minor edits to CLI flow

## 0.7.0

### Minor Changes

- 40cd439: - Use execa instead of spawn for Windows support
  - Update copy for CLI output
  - Install the remote MCP server for users

## 0.6.0

### Minor Changes

- fb4fdf1: - Refactored Neon guidelines to use a separate `neon.md` file instead of adding bulk content to `AGENTS.md`
  - `AGENTS.md` now contains only a minimal reference that triggers when users say "Get started with Neon"
  - Added confirmation prompt when replacing existing `neon.md` files
  - Check for Cursor installation and provide helpful feedback when Cursor isn't installed

## 0.4.1

### Patch Changes

- ff02c00: Initial pre-release of neon-init

  - OAuth-based authentication via neonctl
  - Automatic Neon MCP Server configuration in` ~/.cursor/mcp.json`
  - AGENTS.md creation with Neon best practices and interactive onboarding
  - Interactive "Get started with Neon" guide for AI assistants
  - Organization selection support for multi-org accounts

## 0.4.0

### Minor Changes

- e6d3d49: Initial pre-release of neon-init

  - OAuth-based authentication via neonctl
  - Automatic Neon MCP Server configuration in` ~/.cursor/mcp.json`
  - AGENTS.md creation with Neon best practices and interactive onboarding
  - Interactive "Get started with Neon" guide for AI assistants
  - Organization selection support for multi-org accounts

## 0.3.0

### Minor Changes

- 20c0975: Initial pre-release of neon-init

  - OAuth-based authentication via neonctl
  - Automatic Neon MCP Server configuration in` ~/.cursor/mcp.json`
  - AGENTS.md creation with Neon best practices and interactive onboarding
  - Interactive "Get started with Neon" guide for AI assistants
  - Organization selection support for multi-org accounts

## 0.2.1

### Patch Changes

- 218de01: Fix release flow

## 0.2.0

### Minor Changes

- dace8ad: Initial pre-release of neon-init

  - OAuth-based authentication via neonctl
  - Automatic Neon MCP Server configuration in` ~/.cursor/mcp.json`
  - AGENTS.md creation with Neon best practices and interactive onboarding
  - Interactive "Get started with Neon" guide for AI assistants
  - Organization selection support for multi-org accounts
