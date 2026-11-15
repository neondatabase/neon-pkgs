#!/usr/bin/env node
// Demo of the mapping proposed in docs/template-agent-tooling.md: reads a template's
// `agent` block and runs the real skills and add-mcp CLIs. Not the CLI implementation.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../../packages/cli/package.json"));
const YAML = require("yaml");

const SKILLS_PACKAGE = "skills@latest";
const ADD_MCP_PACKAGE = "add-mcp@2.6.0";
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const [templateId, target = ".", ...rest] = process.argv.slice(2);
const agents = rest.flatMap((arg, i) => (rest[i - 1] === "--agent" ? [arg] : []));
if (!templateId || agents.length === 0) {
	console.error("usage: install-template-tooling.mjs <template-id> <dir> --agent <id>...");
	process.exit(1);
}

const manifest = YAML.parse(readFileSync(join(here, "bootstrap.yaml"), "utf8"));
const template = manifest.templates.find((t) => t.id === templateId);
const tooling = template?.agent ?? {};
const cwd = resolve(target);

const dotenv = (() => {
	const path = join(cwd, ".env");
	if (!existsSync(path)) return {};
	return Object.fromEntries(
		readFileSync(path, "utf8")
			.split(/\r?\n/)
			.map((line) => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/))
			.filter(Boolean)
			.map(([, key, value]) => [key, value.replace(/^(['"])(.*)\1$/, "$2")]),
	);
})();

const lookup = (name) => process.env[name] ?? dotenv[name];

/** Resolves ${VAR} in every value; returns the missing names instead when any is unset. */
const resolveMap = (map = {}) => {
	const missing = [];
	const resolved = {};
	const shown = {};
	for (const [key, value] of Object.entries(map)) {
		resolved[key] = value.replace(PLACEHOLDER, (_, name) => {
			const found = lookup(name);
			if (found === undefined) missing.push(name);
			return found ?? "";
		});
		shown[key] = value.replace(PLACEHOLDER, "…");
	}
	const usedPlaceholder = Object.values(map).some((v) => /\$\{[A-Za-z_]/.test(v));
	return { resolved, shown, missing, usedPlaceholder };
};

const quote = (part) => (/[\s"'\\*${}…]/.test(part) ? `'${part.replace(/'/g, `'\\''`)}'` : part);
const npxLine = (args) => `npx ${args.map(quote).join(" ")}`;

// Like runSkillsCli: no TTY on stdin, so neither CLI nor git can stop to ask a question.
const childEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", FORCE_COLOR: "1" };
delete childEnv.NEON_API_KEY;
delete childEnv.NO_COLOR;

// Keep colours, drop cursor movement, screen clears and OSC sequences: spinner frames
// redrawn in place are noise in a recording, and VHS's terminal stops rendering on them.
const sanitize = (text) =>
	text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, "")
		.split("\n")
		.filter((line) => !/^\s*[◒◐◓◑]/.test(line.replace(/\x1b\[[0-9;]*m/g, "")))
		.join("\n");

// The full child output goes to the log; the terminal gets each CLI's milestone lines.
const log = createWriteStream(resolve("template-tooling.log"));
const MILESTONE = /^\s*(?:[◇●✓]|│\s+✓)\s+(?!.*[─╮╯])/;

const forward = (stream) => {
	let pending = "";
	const emit = (raw) => {
		if (/Unknown env config|npm help npmrc/.test(raw)) return;
		const clean = sanitize(raw.split("\r").pop());
		log.write(`${clean.replace(/\x1b\[[0-9;]*m/g, "")}\n`);
		const plain = clean.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s*│\s*$/, "");
		if (MILESTONE.test(plain)) {
			process.stdout.write(`  ${plain.trim().replaceAll(`${realpathSync(cwd)}/`, `${target}/`)}\n`);
		}
	};
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		const lines = (pending + chunk).split("\n");
		pending = lines.pop();
		for (const line of lines) emit(line);
	});
	stream.on("end", () => {
		if (pending) emit(pending);
	});
};

const results = [];
const run = async (label, args, shownArgs) => {
	process.stdout.write(`\n\x1b[2m$ ${npxLine(shownArgs)}\x1b[0m\n`);
	const child = spawn("npx", args, { cwd, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
	log.write(`$ ${npxLine(shownArgs)}\n`);
	forward(child.stdout);
	forward(child.stderr);
	const status = await new Promise((done) => child.on("close", done));
	results.push({ label, ok: status === 0, retry: npxLine(shownArgs) });
};

const agentFlags = (flag) => agents.flatMap((agent) => [flag, agent]);

for (const entry of tooling.skills ?? []) {
	const args = [
		"-y", SKILLS_PACKAGE, "add", entry.source,
		...entry.skills.flatMap((skill) => ["--skill", skill]),
		...agentFlags("--agent"),
		"-y", "--metadata", JSON.stringify({ origin: "neon-cli", command: "bootstrap" }),
	];
	await run(`skill ${entry.skills.join(", ")} (${entry.source})`, args, args);
}

for (const server of tooling.mcp ?? []) {
	const isRemote = typeof server.url === "string";
	const values = resolveMap(isRemote ? server.headers : server.env);
	const pairs = (map) =>
		Object.entries(map).flatMap(([key, value]) =>
			isRemote ? ["--header", `${key}: ${value}`] : ["--env", `${key}=${value}`],
		);
	const targetArg = isRemote ? server.url : server.command.map(quote).join(" ");
	const base = [
		"-y", ADD_MCP_PACKAGE, targetArg,
		"--name", server.name,
		...agentFlags("-a"),
		...(server.transport === "sse" ? ["--transport", "sse"] : []),
		"-y",
	];
	const tail = values.usedPlaceholder ? ["--gitignore"] : [];
	if (values.missing.length > 0) {
		const flag = isRemote ? "--header" : "--env";
		const sep = isRemote ? ": " : "=";
		const expandable = Object.entries(isRemote ? server.headers : server.env)
			.map(([key, value]) => `${flag} "${key}${sep}${value.replace(PLACEHOLDER, "$$$1")}"`)
			.join(" ");
		results.push({
			label: `MCP server ${server.name}`,
			skipped: `${values.missing.join(", ")} is not set`,
			retry: `${npxLine(base)} ${expandable}${tail.length > 0 ? " --gitignore" : ""}`,
			needs: values.missing,
		});
		continue;
	}
	await run(`MCP server ${server.name}`, [...base, ...pairs(values.resolved), ...tail], [
		...base, ...pairs(values.shown), ...tail,
	]);
}

process.stdout.write(`\nTemplate tooling for ${agents.join(", ")}:\n`);
for (const result of results) {
	const mark = result.skipped ? "\x1b[33m–\x1b[0m" : result.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
	process.stdout.write(`  ${mark} ${result.label}${result.skipped ? ` (skipped: ${result.skipped})` : ""}\n`);
}
for (const result of results.filter((r) => r.skipped || !r.ok)) {
	const first = result.needs ? `Set ${result.needs.join(", ")}, then retry` : "Retry";
	process.stdout.write(`\n\x1b[33mWARNING:\x1b[0m ${result.label} was not installed. ${first}:\n  ${result.retry}\n`);
}
process.stdout.write("\nFull installer output: template-tooling.log\n");
log.end(() => process.exit(results.some((r) => !r.skipped && !r.ok) ? 1 : 0));
