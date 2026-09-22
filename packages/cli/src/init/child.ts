import { spawn } from "node:child_process";
import { InitCancelled } from "./cancelled.js";

export type InitRun = (
	argv: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
) => Promise<boolean>;

// bootstrap re-execs link, which needs the key in this process env.
export const AUTH_CHILD = new Set(["bootstrap", "link", "mcp", "env"]);

export const initChildEnv = (
	command: string | undefined,
	overlay: NodeJS.ProcessEnv | undefined,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
	const child = { ...base };
	if (command === undefined || !AUTH_CHILD.has(command)) {
		for (const key of Object.keys(child)) {
			if (key.toUpperCase() === "NEON_API_KEY") {
				delete child[key];
			}
		}
	}
	return overlay ? { ...child, ...overlay } : child;
};

export const spawnCliChild: InitRun = async (argv, cwd, overlay) => {
	const cli = process.argv[1];
	if (!cli) {
		throw new Error(
			"Cannot re-exec the Neon CLI: process.argv[1] is missing.",
		);
	}
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [cli, ...argv], {
			cwd,
			stdio: "inherit",
			env: initChildEnv(argv[0], overlay),
		});
		const onSigint = () => {
			child.kill("SIGINT");
		};
		process.on("SIGINT", onSigint);
		const finish = (code: number | null, signal: NodeJS.Signals | null) => {
			process.off("SIGINT", onSigint);
			if (signal === "SIGINT" || signal === "SIGTERM") {
				reject(new InitCancelled());
				return;
			}
			resolve(code === 0);
		};
		child.on("error", () => {
			process.off("SIGINT", onSigint);
			resolve(false);
		});
		child.on("close", finish);
	});
};
