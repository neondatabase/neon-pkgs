#!/usr/bin/env node

console.warn("");
console.warn(
	"\x1b[33m%s\x1b[0m",
	'⚠️  DEPRECATION WARNING: The "neondb" package has been renamed to "neon-new".',
);
console.warn("\x1b[33m%s\x1b[0m", '   Please use "neon-new" instead.');

import { dirname, resolve } from "node:path";
// Import and run the CLI from neon-new
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get the path to neon-new's CLI
const neonNewCliPath = resolve(__dirname, "../../neon-new/dist/cli.js");

// Import and execute the neon-new CLI
import(neonNewCliPath);
