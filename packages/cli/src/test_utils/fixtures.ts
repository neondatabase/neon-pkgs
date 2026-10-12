import { fork } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import emocks from "emocks";
import express from "express";
import strip from "strip-ansi";
import { expect, test as originalTest } from "vitest";

import { log } from "../log";

type Fixtures = {
	runMockServer: (
		mockDir: string,
		onRequest?: (request: { method: string; path: string }) => void,
	) => Promise<Server>;
	testCliCommand: (
		args: string[],
		options?: {
			mockDir?: string;
			stderr?: string;
			stdout?: string;
			code?: number;
			outputTable?: boolean;
			output?: "json" | "yaml" | "table";
			env?: Record<string, string>;
			/** Working directory to run the forked CLI in (e.g. a temp dir a command scaffolds into). */
			cwd?: string;
			/**
			 * Point the CLI at a port that is bound and then immediately released, so the
			 * request fails with a genuine connection error (ECONNREFUSED) instead of a slow
			 * DNS timeout. Used to exercise the CLI's network-error handling end to end without
			 * a mock server in the loop.
			 */
			unreachableHost?: boolean;
			apiKey?: string | false;
			snapshot?: boolean;
		},
	) => Promise<{ stdout: string; stderr: string; code: number | null }>;
};

/**
 * Reserve a localhost port and close its listener, returning a URL that is guaranteed to
 * refuse connections right now. Lets a test drive the CLI into a real `ECONNREFUSED`
 * (the same shape a network blip produces) deterministically and fast.
 */
const reserveClosedPort = (): Promise<string> =>
	new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as AddressInfo;
			probe.close((err) => {
				if (err) {
					reject(err);
				} else {
					resolve(`http://127.0.0.1:${port}`);
				}
			});
		});
	});

/** Tokens yargs would turn into numbers. `1.50` and `1e3` do not survive the round trip. */
export const NUMERIC_PSQL_ARGS = ["-c", "1", "-p", "5432", "-v", "1.50", "1e3"];

/** The arguments `mocks/bin/psql` received after the connection URI. */
export const forwardedPsqlArgs = (stdout: string): unknown[] => {
	const match = /\{"psql-cli-args":(\[.*?\])\}/.exec(stdout);
	if (!match) {
		throw new Error(`mocks/bin/psql did not run. stdout: ${stdout}`);
	}
	const args: unknown = JSON.parse(match[1]);
	if (!Array.isArray(args)) {
		throw new Error(`psql-cli-args is not an array: ${match[1]}`);
	}
	return args.slice(1);
};

/** The CLI rejects `--output` given twice with different values, so a test's own wins. */
export const passesOutput = (args: readonly string[]) =>
	args.some(
		(arg) =>
			arg === "-o" || arg === "--output" || arg.startsWith("--output="),
	);

export const test = originalTest.extend<Fixtures>({
	runMockServer: async ({}, use) => {
		let startedServer: Server | undefined;
		await use(async (mockDir, onRequest) => {
			const app = express();
			if (onRequest) {
				app.use((req, _res, next) => {
					onRequest({ method: req.method, path: req.path });
					next();
				});
			}
			app.use(express.json());
			app.use(
				"/",
				emocks(join(process.cwd(), "mocks", mockDir), {
					"404": (_req, res) =>
						res.status(404).send({ message: "Not Found" }),
				}),
			);

			const server = await new Promise<Server>((resolve) => {
				const s = app.listen(0, () => {
					log.debug(
						"Mock server listening at %d",
						(s.address() as AddressInfo).port,
					);
					resolve(s);
				});
			});
			startedServer = server;
			return server;
		});
		// `unreachableHost` tests never start the server, so only close it when it ran.
		const server = startedServer;
		if (server) {
			await new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (err) {
						reject(
							err instanceof Error ? err : new Error(String(err)),
						);
					} else {
						resolve();
					}
				});
			});
		}
	},
	testCliCommand: async ({ runMockServer }, use) => {
		await use(async (args, options = {}) => {
			const apiHost = options.unreachableHost
				? await reserveClosedPort()
				: `http://localhost:${
						(
							(
								await runMockServer(options.mockDir || "main")
							).address() as AddressInfo
						).port
					}`;
			let output = "";
			let error = "";

			const cp = fork(
				join(process.cwd(), "./dist/index.js"),
				[
					"--api-host",
					apiHost,
					...(passesOutput(args)
						? []
						: [
								"--output",
								options.output ??
									(options.outputTable ? "table" : "yaml"),
							]),
					"--no-analytics",
					...(options.apiKey === false
						? []
						: ["--api-key", options.apiKey ?? "test-key"]),
					...args,
				],
				{
					stdio: "pipe",
					...(options.cwd ? { cwd: options.cwd } : {}),
					env: {
						PATH: `${join(process.cwd(), "mocks/bin")}:${process.env.PATH}`,
						...(options.env ?? {}),
					},
				},
			);

			return new Promise<{
				stdout: string;
				stderr: string;
				code: number | null;
			}>((resolve, reject) => {
				cp.stdout?.on("data", (data: Buffer) => {
					output += data.toString();
				});

				cp.stderr?.on("data", (data: Buffer) => {
					error += data.toString();
					log.error(data.toString());
				});

				cp.on("error", (err) => {
					log.error(err);
					throw err;
				});

				cp.on("close", (code) => {
					try {
						expect(code).toBe(options?.code ?? 0);
						if (options.snapshot !== false) {
							expect(output).toMatchSnapshot();
						}
						if (options.stderr !== undefined) {
							expect(
								strip(error).replace(/\s+/g, " ").trim(),
							).toEqual(
								typeof options.stderr === "string"
									? options.stderr
											.toString()
											.replace(/\s+/g, " ")
									: options.stderr,
							);
						}
						if (options.stdout !== undefined) {
							expect(
								strip(output).replace(/\s+/g, " ").trim(),
							).toEqual(
								typeof options.stdout === "string"
									? options.stdout
											.toString()
											.replace(/\s+/g, " ")
									: options.stdout,
							);
						}
						resolve({ stdout: output, stderr: error, code });
					} catch (err) {
						reject(
							err instanceof Error ? err : new Error(String(err)),
						);
					}
				});
			}).catch((err: unknown) => {
				log.error(err);
				throw err;
			});
		});
	},
});
