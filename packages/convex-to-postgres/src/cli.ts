#!/usr/bin/env node

import { runCli } from "./cli/commands.js";

// `exitCode` rather than `process.exit()`, so a large script piped to `psql`
// is flushed to stdout before the process ends.
process.exitCode = await runCli(process.argv.slice(2), {
	stdout: process.stdout,
	stderr: process.stderr,
	env: process.env,
	cwd: process.cwd(),
});
