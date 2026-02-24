#!/usr/bin/env node

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { init } from "./index.js";
import type { Editor } from "./lib/types.js";

const AGENT_FLAG_VALUES = ["cursor", "copilot", "claude"] as const;

function parseAgentToEditor(value: string): Editor | null {
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "cursor":
			return "Cursor";
		case "github-copilot":
		case "copilot":
		case "vs code":
		case "vscode":
		case "vs-code":
			return "VS Code";
		case "claude-code":
		case "claude cli":
		case "claude-cli":
		case "claude":
			return "Claude CLI";
		default:
			return null;
	}
}

const argv = yargs(hideBin(process.argv))
	.scriptName("neon-init")
	.option("agent", {
		alias: "a",
		type: "string",
		description: "Agent to configure (cursor, copilot, claude).",
	})
	.help()
	.parseSync();

const agentArg = argv.agent;
if (agentArg !== undefined) {
	const editor = parseAgentToEditor(agentArg);
	if (editor === null) {
		console.error(
			`Invalid --agent value: "${agentArg}". Supported: ${AGENT_FLAG_VALUES.join(", ")}`,
		);
		process.exit(1);
	}
	await init({ agent: editor });
} else {
	await init();
}
