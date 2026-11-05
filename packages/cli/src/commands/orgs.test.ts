import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { type RecordedRequest, test } from "../test_utils/fixtures";
import { parseUsdCents, planName } from "./orgs";

const recorder = () => {
	const requests: RecordedRequest[] = [];
	return {
		onRequest: (request: RecordedRequest) => requests.push(request),
		calls: () => requests.map((r) => `${r.method} ${r.path}`),
		bodies: () => requests.map((r) => r.body),
	};
};

describe("orgs", () => {
	test("list", async ({ testCliCommand }) => {
		await testCliCommand(["orgs", "list"]);
	});

	const linkedTo = (orgId: string) => {
		const path = join(mkdtempSync(join(tmpdir(), "neon-orgs-")), ".neon");
		writeFileSync(path, JSON.stringify({ orgId }));
		return path;
	};

	test("list marks the linked org and shows plans in the table", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["orgs", "list", "--context-file", linkedTo("org-linked-123")],
			{ output: "table", mockDir: "orgs-plans" },
		);
	});

	test("list keeps JSON free of the marker", async ({ testCliCommand }) => {
		const linked = await testCliCommand(
			["orgs", "list", "--context-file", linkedTo("org-linked-123")],
			{ output: "json", mockDir: "orgs-plans", snapshot: false },
		);
		const unlinked = await testCliCommand(["orgs", "list"], {
			output: "json",
			mockDir: "orgs-plans",
			snapshot: false,
		});
		expect(linked.stdout).toBe(unlinked.stdout);
		expect(linked.stdout).not.toContain("[current]");
	});

	test("planName turns plan ids into names", () => {
		expect(planName("free_v3")).toBe("Free");
		expect(planName("launch")).toBe("Launch");
		expect(planName("free_extended")).toBe("Free Extended");
		expect(planName("aws_marketplace")).toBe("AWS Marketplace");
		expect(planName("vercel_pg_legacy")).toBe("Vercel PG Legacy");
		expect(planName(undefined)).toBe("");
	});

	test("get shows the organization in the table", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["orgs", "get", "org-7"], { output: "table" });
	});

	test("get takes the org from --org-id, then the linked org", async ({
		testCliCommand,
	}) => {
		const flag = recorder();
		await testCliCommand(["orgs", "get", "--org-id", "org-7"], {
			onRequest: flag.onRequest,
			snapshot: false,
		});
		expect(flag.calls()).toEqual(["GET /organizations/org-7"]);

		const linked = recorder();
		await testCliCommand(
			["orgs", "get", "--context-file", linkedTo("org-7")],
			{ onRequest: linked.onRequest, snapshot: false },
		);
		expect(linked.calls()).toEqual(["GET /organizations/org-7"]);
	});

	test("get without an org names --org-id when there are several", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["orgs", "get"], {
			code: 1,
			stderr: expect.stringContaining(
				"Multiple organizations found, please provide one with the --org-id option",
			),
			snapshot: false,
		});
	});

	test("members list flattens member and user in the table", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["orgs", "members", "list", "--org-id", "org-7"], {
			output: "table",
		});
	});

	test("members list keeps the API items in JSON", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			["orgs", "members", "list", "--org-id", "org-7"],
			{ output: "json", snapshot: false },
		);
		expect(JSON.parse(stdout)[0]).toMatchObject({
			member: { id: "m-1", role: "admin" },
			user: { email: "admin@example.com" },
		});
	});

	test("members update sends the role", async ({ testCliCommand }) => {
		const seen = recorder();
		await testCliCommand(
			[
				"orgs",
				"members",
				"update",
				"m-1",
				"--role",
				"viewer",
				"--org-id",
				"org-7",
			],
			{ onRequest: seen.onRequest },
		);
		expect(seen.calls()).toEqual([
			"PATCH /organizations/org-7/members/m-1",
		]);
		expect(seen.bodies()).toEqual([{ role: "viewer" }]);
	});

	test("members remove reports on stderr", async ({ testCliCommand }) => {
		const seen = recorder();
		await testCliCommand(
			["orgs", "members", "remove", "m-1", "--org-id", "org-7"],
			{
				onRequest: seen.onRequest,
				stderr: expect.stringContaining(
					"Member m-1 removed from org-7",
				),
				snapshot: false,
			},
		);
		expect(seen.calls()).toEqual([
			"DELETE /organizations/org-7/members/m-1",
		]);
	});

	test("invitations create sends one invitation per --email", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			[
				"orgs",
				"invitations",
				"create",
				"--email",
				"a@example.com",
				"--email",
				"b@example.com",
				"--role",
				"member",
				"--org-id",
				"org-7",
			],
			{ onRequest: seen.onRequest, output: "table" },
		);
		expect(seen.bodies()).toEqual([
			{
				invitations: [
					{ email: "a@example.com", role: "member" },
					{ email: "b@example.com", role: "member" },
				],
			},
		]);
	});

	test("spending-limit get shows an unset limit", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["orgs", "spending-limit", "get", "--org-id", "org-7"],
			{ output: "table" },
		);
	});

	test("spending-limit set sends cents and shows dollars", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			["orgs", "spending-limit", "set", "1250.5", "--org-id", "org-7"],
			{ onRequest: seen.onRequest, output: "table" },
		);
		expect(seen.bodies()).toEqual([{ spending_limit_cents: 125050 }]);
	});

	test("spending-limit set refuses zero before any request", async ({
		testCliCommand,
	}) => {
		const seen = recorder();
		await testCliCommand(
			["orgs", "spending-limit", "set", "0", "--org-id", "org-7"],
			{
				onRequest: seen.onRequest,
				code: 1,
				stderr: expect.stringContaining(
					"neon orgs spending-limit delete",
				),
				snapshot: false,
			},
		);
		expect(seen.calls()).toEqual([]);
	});

	test("spending-limit delete reports on stderr", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["orgs", "spending-limit", "delete", "--org-id", "org-7"],
			{
				stderr: expect.stringContaining(
					"Spending limit removed from org-7",
				),
				snapshot: false,
			},
		);
	});

	test("a malformed --org-id fails before any request instead of using .neon", async ({
		testCliCommand,
	}) => {
		const linked = linkedTo("org-linked-production");
		for (const flags of [
			["--org-id", ""],
			["--no-org-id"],
			["--org_id", "org-7"],
			["--org-id", "org-7", "--org-id", "org-8"],
			["--", "--org-id", "org-7"],
		]) {
			const seen = recorder();
			await testCliCommand(
				[
					"orgs",
					"invitations",
					"create",
					"--email",
					"a@example.com",
					"--role",
					"admin",
					"--context-file",
					linked,
					...flags,
				],
				{ onRequest: seen.onRequest, code: 1, snapshot: false },
			);
			expect(seen.calls(), flags.join(" ")).toEqual([]);
		}
	});

	test("parseUsdCents reads dollars as text", () => {
		expect(parseUsdCents("500")).toBe(50_000);
		expect(parseUsdCents("0.29")).toBe(29);
		expect(parseUsdCents("250.5")).toBe(25_050);
		for (const bad of ["0", "1e3", "0x10", "-5", "1.234", "$5", ""]) {
			expect(() => parseUsdCents(bad), bad).toThrow("positive amount");
		}
	});
});
