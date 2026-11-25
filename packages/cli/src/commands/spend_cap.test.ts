import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import strip from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { SpendingLimitResponse } from "../spend_caps_api.js";

const reachedCap: SpendingLimitResponse = {
	spending_limit_cents: 10000,
	spend_cap_enabled: true,
	current_usage_cents: 10042,
	usage_observed_at: "2026-11-25T09:00:00Z",
	invoice_period_id: "current-open-invoice",
	status: "reached",
	enforcement_status: "pending",
	generation: 7,
	period_ends_at: "2026-12-01T00:00:00Z",
	monitoring_delay: "1-2 hours",
	warning:
		"Observed usage $100.42 has reached the $100.00 cap. Storage charges continue.",
};

type Request = {
	method?: string;
	path?: string;
	body: Record<string, unknown>;
	authorization?: string;
	contentType?: string;
};
let server: Server;
let configDir: string;
let baseURL: string;
let current: SpendingLimitResponse;
let requests: Request[];
let error: { code: string; message: string } | undefined;
let organizations: { id: string; name: string }[];

beforeEach(async () => {
	current = { ...reachedCap };
	requests = [];
	error = undefined;
	organizations = [{ id: "org-test", name: "Test" }];
	configDir = await mkdtemp(join(tmpdir(), "neonctl-spend-cap-"));
	// A local HTTP server exercises SDK authentication, routing, serialization,
	// and the real CLI process without changing a customer's billing settings.
	server = createServer((req, res) => {
		void (async () => {
			let raw = "";
			for await (const chunk of req) raw += String(chunk);
			const body = raw
				? (JSON.parse(raw) as Record<string, unknown>)
				: {};
			requests.push({
				method: req.method,
				path: req.url,
				body,
				authorization: req.headers.authorization,
				contentType: req.headers["content-type"],
			});
			res.setHeader("Content-Type", "application/json");
			if (error) {
				res.writeHead(403).end(JSON.stringify(error));
			} else if (req.url === "/api/v2/users/me/organizations") {
				res.end(JSON.stringify({ organizations }));
			} else if (
				req.url ===
					"/api/v2/organizations/org-test/billing/spending_limit" ||
				req.url ===
					"/api/v2/organizations/org%2Ftest/billing/spending_limit"
			) {
				if (req.method === "PUT") {
					current = {
						...current,
						spending_limit_cents:
							body.spending_limit_cents as number,
						...(body.spend_cap_enabled !== undefined
							? {
									spend_cap_enabled:
										body.spend_cap_enabled as boolean,
								}
							: {}),
					};
				}
				res.end(JSON.stringify(current));
			} else {
				res.writeHead(404).end(
					JSON.stringify({ message: "Unexpected request" }),
				);
			}
		})();
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2`;
});

afterEach(async () => {
	await new Promise<void>((resolve, reject) =>
		server.close((err) => {
			if (err) reject(err);
			else resolve();
		}),
	);
	await rm(configDir, { recursive: true, force: true });
});

const runCli = (args: string[], output = "json") =>
	new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
		execFile(
			process.execPath,
			[
				join(process.cwd(), "dist/cli.js"),
				"--api-host",
				baseURL,
				"--api-key",
				"test-spend-key",
				"--config-dir",
				configDir,
				"--context-file",
				join(configDir, "context.json"),
				"--no-analytics",
				"--no-color",
				"--output",
				output,
				...args,
			],
			{
				env: {
					...process.env,
					NEON_API_KEY: "",
					NEON_API_HOST: baseURL,
				},
			},
			(err, stdout, stderr) => {
				resolve({
					code:
						err && typeof err.code === "number"
							? err.code
							: err
								? -1
								: 0,
					stdout,
					stderr: strip(stderr),
				});
			},
		);
	});

const spendCap = (args: string[], output = "json") =>
	runCli(["org", "spend-cap", ...args, "--org-id", "org-test"], output);

describe("organization spend-cap CLI", () => {
	it.each([
		"json",
		"yaml",
		"table",
	])("shows current usage, pending status, warning and monitoring delay in %s", async (output) => {
		const result = await spendCap(["get"], output);
		expect(result.code, result.stderr).toBe(0);
		expect(requests).toMatchObject([
			{
				method: "GET",
				path: "/api/v2/organizations/org-test/billing/spending_limit",
				authorization: "Bearer test-spend-key",
			},
		]);
		if (output === "table") {
			expect(result.stdout).toContain("$100.42");
			expect(result.stdout).toContain("$100.00");
			expect(result.stdout).toContain("pending");
			expect(result.stdout).toContain(reachedCap.warning);
			expect(result.stdout).toContain("1-2 hours");
		} else {
			const data =
				output === "json"
					? JSON.parse(result.stdout)
					: YAML.parse(result.stdout);
			expect(data).toMatchObject(reachedCap);
			expect(data.notice).toContain("acknowledged asynchronously");
		}
		expect(result.stdout).toContain("Storage charges continue");
	});

	it.each([
		false,
		true,
	])("amount-only set preserves existing suspension=%s", async (enabled) => {
		current.spend_cap_enabled = enabled;
		const result = await spendCap(["set", "--amount", "200.29"]);
		expect(result.code, result.stderr).toBe(0);
		expect(current.spending_limit_cents).toBe(20029);
		expect(current.spend_cap_enabled).toBe(enabled);
		expect(requests).toMatchObject([
			{
				method: "PUT",
				body: { spending_limit_cents: 20029 },
				contentType: "application/json",
			},
		]);
		expect(requests[0].body).not.toHaveProperty("spend_cap_enabled");
		expect(JSON.parse(result.stdout).notice).toContain(
			"Configuration accepted.",
		);
	});

	it("explicitly opts into suspension and returns a reached-cap save warning", async () => {
		current.spend_cap_enabled = false;
		const result = await spendCap([
			"set",
			"--amount",
			"100",
			"--spend-cap-enabled",
		]);
		expect(result.code, result.stderr).toBe(0);
		expect(current.spend_cap_enabled).toBe(true);
		expect(requests[0].body).toEqual({
			spending_limit_cents: 10000,
			spend_cap_enabled: true,
		});
		expect(JSON.parse(result.stdout)).toMatchObject({
			warning: reachedCap.warning,
			enforcement_status: "pending",
		});
	});

	it("accepts explicit false on set", async () => {
		const result = await spendCap([
			"set",
			"--amount",
			"100",
			"--spend-cap-enabled=false",
		]);
		expect(result.code, result.stderr).toBe(0);
		expect(current.spend_cap_enabled).toBe(false);
		expect(requests[0].body).toEqual({
			spending_limit_cents: 10000,
			spend_cap_enabled: false,
		});
	});

	it("disables through GET then PUT and retains the notification amount", async () => {
		const result = await spendCap(["disable"]);
		expect(result.code, result.stderr).toBe(0);
		expect(requests.map((req) => req.method)).toEqual(["GET", "PUT"]);
		expect(requests[1].body).toEqual({
			spending_limit_cents: 10000,
			spend_cap_enabled: false,
		});
		expect(current.spending_limit_cents).toBe(10000);
		expect(current.spend_cap_enabled).toBe(false);
		expect(JSON.parse(result.stdout).enforcement_status).toBe("pending");
	});

	it("does not fabricate an amount or write when disabling an unset threshold", async () => {
		current = { spending_limit_cents: null };
		const result = await spendCap(["disable"]);
		expect(result.code, result.stderr).toBe(0);
		expect(requests.map((req) => req.method)).toEqual(["GET"]);
		expect(JSON.parse(result.stdout)).toMatchObject({
			spending_limit_cents: null,
		});
		expect(JSON.parse(result.stdout)).not.toHaveProperty(
			"enforcement_status",
		);
	});

	it.each([
		"json",
		"yaml",
		"table",
	])("does not invent optional status on an older server (%s)", async (output) => {
		current = { spending_limit_cents: 10000 };
		const result = await spendCap(["get"], output);
		expect(result.code, result.stderr).toBe(0);
		if (output === "table") {
			expect(result.stdout).toContain("Unavailable / unsupported");
		} else {
			const data =
				output === "json"
					? JSON.parse(result.stdout)
					: YAML.parse(result.stdout);
			expect(data).not.toHaveProperty("enforcement_status");
			expect(data).not.toHaveProperty("status");
			expect(data).not.toHaveProperty("spend_cap_enabled");
		}
	});

	it("resolves the sole organization when no org-id is supplied", async () => {
		const result = await runCli(["orgs", "spend-cap", "get"]);
		expect(result.code, result.stderr).toBe(0);
		expect(requests.map((req) => req.path)).toEqual([
			"/api/v2/users/me/organizations",
			"/api/v2/organizations/org-test/billing/spending_limit",
		]);
	});

	it("uses the linked organization without listing user organizations", async () => {
		await writeFile(
			join(configDir, "context.json"),
			JSON.stringify({ orgId: "org-test" }),
		);
		const result = await runCli(["org", "spend-cap", "get"]);
		expect(result.code, result.stderr).toBe(0);
		expect(requests.map((req) => req.path)).toEqual([
			"/api/v2/organizations/org-test/billing/spending_limit",
		]);
	});

	it("prints parent help with no subcommand without contacting the API", async () => {
		const result = await runCli(["org", "spend-cap"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("Disable suspension");
		expect(requests).toHaveLength(0);
	});

	it.each([
		null,
		0,
	])("retains unavailable versus zero observed usage (%s)", async (usage) => {
		current.current_usage_cents = usage;
		current.usage_observed_at = null;
		const result = await spendCap(["get"]);
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			current_usage_cents: usage,
			usage_observed_at: null,
		});
	});

	it.each([
		"off",
		"pending",
		"applied",
	])("preserves the backend acknowledgement status %s", async (status) => {
		current.enforcement_status = status;
		const result = await spendCap(["get"]);
		expect(result.code, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).enforcement_status).toBe(status);
		expect(JSON.parse(result.stdout).notice).toContain(
			"does not confirm every workload",
		);
	});

	it("requires explicit scope when multiple organizations are available", async () => {
		organizations.push({ id: "org-other", name: "Other" });
		const result = await runCli(["org", "spend-cap", "get"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--org-id");
		expect(requests).toHaveLength(1);
	});

	it("rejects an invalid organization path without sending a request", async () => {
		const result = await runCli([
			"org",
			"spend-cap",
			"get",
			"--org-id",
			"org/test",
		]);
		expect(result.code).toBe(1);
		expect(requests).toHaveLength(0);
	});

	it.each([
		"0",
		"-1",
		"1.001",
		"1e2",
		"Infinity",
		"NaN",
		"90071992547409.92",
		"92233720368547758.07",
	])("rejects invalid or unsafe amount %s without any billing request", async (amount) => {
		const result = await spendCap(["set", "--amount", amount]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("positive amount");
		expect(requests).toHaveLength(0);
	});

	it.each([
		["0.01", 1],
		["1.15", 115],
		["90071992547409.91", Number.MAX_SAFE_INTEGER],
	] as const)("serializes %s exactly in integer cents", async (amount, cents) => {
		const result = await spendCap(["set", "--amount", amount]);
		expect(result.code, result.stderr).toBe(0);
		expect(current.spending_limit_cents).toBe(cents);
	});

	it("renders the largest supported currency value exactly", async () => {
		current.spending_limit_cents = Number.MAX_SAFE_INTEGER;
		const result = await spendCap(["get"], "table");
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("$90,071,992,547,409.91");
	});

	it.each([
		"spending_limit_cents",
		"current_usage_cents",
		"generation",
	] as const)("rejects unsafe API %s instead of silently rounding", async (field) => {
		current[field] = Number.MAX_SAFE_INTEGER + 1;
		const result = await spendCap(["disable"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`unsupported ${field}`);
		expect(requests.map((req) => req.method)).toEqual(["GET"]);
		expect(result.stdout).toBe("");
	});

	it("rejects unknown options rather than silently ignoring an opt-in typo", async () => {
		const result = await spendCap([
			"set",
			"--amount",
			"100",
			"--spend-cap-enabld",
		]);
		expect(result.code).toBe(1);
		expect(requests).toHaveLength(0);
	});

	it("reports backend admin permission errors with the original code and message", async () => {
		error = {
			code: "INSUFFICIENT_ORG_PERMISSIONS",
			message: "Only an administrator may update this organization",
		};
		const result = await spendCap(["set", "--amount", "100"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(error.code);
		expect(result.stderr).toContain(error.message);
		expect(result.stderr).toContain("Organization Admin");
		expect(requests).toHaveLength(1);
	});

	it("prints cap code and Billing guidance for an existing blocked command and exits without retry", async () => {
		error = {
			code: "SPEND_CAP_EXCEEDED",
			message: "This organization has reached its spend cap",
		};
		const result = await runCli([
			"projects",
			"create",
			"--name",
			"blocked-project",
			"--org-id",
			"org-test",
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(error.code);
		expect(result.stderr).toContain(error.message);
		expect(result.stderr).toContain("Organization Billing");
		expect(requests).toHaveLength(1);
	});
});
