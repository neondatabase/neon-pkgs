import { spawn } from "child_process";

import which from "which";

import { closeAnalytics, trackEvent } from "../analytics.js";
import { log } from "../log.js";

export type PsqlMode = "native" | "ts" | "auto";

export type PsqlOpts = {
	mode?: PsqlMode;
};

const FALLBACK_ENV = "NEONCTL_PSQL_FALLBACK";

/** Cap on the analytics flush, counted from when psql launches. */
const ANALYTICS_FLUSH_TIMEOUT_MS = 3000;

/** Why a given psql implementation was chosen — recorded for analytics. */
type PsqlReason =
	| "forced_flag" // --fallback / mode: 'ts' from the command
	| "forced_env" // NEONCTL_PSQL_FALLBACK=1
	| "forced_native" // mode: 'native' from the command
	| "native_available" // auto + a native psql is on PATH
	| "fallback_no_native"; // auto + no native psql → embedded TS

type PsqlPlan = {
	implementation: "ts" | "native";
	reason: PsqlReason;
	/** Whether a native psql was found on PATH. `null` when we didn't probe. */
	nativeAvailable: boolean | null;
	/** Resolved native binary path (only set when probed and found). */
	nativePath: string | null;
};

/**
 * Decide which psql implementation will run, and why. The PATH probe is
 * skipped when TS is forced (flag or env) — we don't need it and it'd be a
 * wasted lookup — so `nativeAvailable` is `null` ("not checked") in those
 * cases rather than a misleading `false`.
 */
const planPsql = async (opts: PsqlOpts): Promise<PsqlPlan> => {
	if (opts.mode === "ts") {
		return {
			implementation: "ts",
			reason: "forced_flag",
			nativeAvailable: null,
			nativePath: null,
		};
	}
	if (process.env[FALLBACK_ENV] === "1") {
		return {
			implementation: "ts",
			reason: "forced_env",
			nativeAvailable: null,
			nativePath: null,
		};
	}

	const nativePath = await which("psql", { nothrow: true });
	const nativeAvailable = nativePath !== null;

	if (opts.mode === "native") {
		return {
			implementation: "native",
			reason: "forced_native",
			nativeAvailable,
			nativePath,
		};
	}

	// 'auto' (or unset): strict fallback — prefer native, TS only if missing.
	return nativeAvailable
		? {
				implementation: "native",
				reason: "native_available",
				nativeAvailable,
				nativePath,
			}
		: {
				implementation: "ts",
				reason: "fallback_no_native",
				nativeAvailable,
				nativePath,
			};
};

const execNative = async (
	binary: string,
	connection_uri: string,
	args: string[],
): Promise<number> => {
	log.info(`${connectionSummary(connection_uri, args)}; launching psql...`);
	const child = spawn(binary, [connection_uri, ...args], {
		stdio: "inherit",
	});

	for (const signame of ["SIGINT", "SIGTERM"]) {
		process.on(signame, (code) => {
			if (!child.killed && code !== null) {
				child.kill(code as NodeJS.Signals);
			}
		});
	}

	return new Promise<number>((resolve, reject) => {
		child.on("exit", (code: number | null) => {
			resolve(code === null ? 1 : code);
		});
		child.on("error", reject);
	});
};

const execTs = async (
	connection_uri: string,
	args: string[],
): Promise<number> => {
	log.info(
		`${connectionSummary(connection_uri, args)}; launching embedded psql (TypeScript)...`,
	);
	const { runPsql } = await import("../psql/index.js");
	return runPsql([connection_uri, ...args], {
		stdin: process.stdin,
		stdout: process.stdout,
		stderr: process.stderr,
	});
};

const GENERIC_CONNECTING = "Connecting to the database";

// psql arguments after `--` that can point the session somewhere other than the URI.
const CONNECTION_OVERRIDE = /^(-[dhpU]|--(dbname|host|port|username)(=|$))/;

export const connectionSummary = (
	connection_uri: string,
	args: string[] = [],
): string => {
	if (args.some((arg) => CONNECTION_OVERRIDE.test(arg))) {
		return GENERIC_CONNECTING;
	}
	try {
		const url = new URL(connection_uri);
		const part = (value: string) =>
			decodeURIComponent(value).replace(/[\u0000-\u001f\u007f]/g, "");
		const database = part(url.pathname.replace(/^\//, ""));
		const role = part(url.username);
		if (!database || !role || !url.host) {
			return GENERIC_CONNECTING;
		}
		return `Neon connection: ${database} as ${role} on ${url.host}`;
	} catch {
		// A URI this summary can't read is still psql's to accept or reject.
		return GENERIC_CONNECTING;
	}
};

export const psql = async (
	connection_uri: string,
	args: string[] = [],
	opts: PsqlOpts = {},
): Promise<never> => {
	const plan = await planPsql(opts);

	trackEvent("psql_invoked", {
		implementation: plan.implementation,
		reason: plan.reason,
		nativeAvailable: plan.nativeAvailable,
	});
	// psql exits through process.exit, which drops unsent events, so the flush is awaited
	// before exiting. It starts now and runs while psql does; the cap counts from here.
	const flushed = closeAnalytics({ timeout: ANALYTICS_FLUSH_TIMEOUT_MS });

	let code: number;
	if (plan.implementation === "ts") {
		if (plan.reason === "fallback_no_native") {
			log.info(
				"psql binary not found on PATH; falling back to embedded TypeScript psql",
			);
		}
		code = await execTs(connection_uri, args);
	} else if (plan.nativePath === null) {
		// Only reachable when native was explicitly requested (mode: 'native')
		// but no binary is on PATH.
		log.error(`psql is not available in the PATH`);
		code = 1;
	} else {
		code = await execNative(plan.nativePath, connection_uri, args);
	}

	await flushed;
	process.exit(code);
};
