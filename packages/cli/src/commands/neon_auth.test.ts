import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { type RecordedRequest, test } from "../test_utils/fixtures";

describe("neon-auth", () => {
	// --- Enable / Status / Disable ---

	test("enable", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"enable",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("enable already enabled", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"neon-auth",
				"enable",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ mockDir: "neon-auth-already-enabled" },
		);
	});

	test("enable reports a provisioning conflict on a branch without Neon Auth", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"neon-auth",
				"enable",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{
				mockDir: "neon-auth-schema-conflict",
				code: 1,
				stderr: "ERROR: The `neon_auth` schema already exists and cannot be automatically provisioned. Please drop the existing `neon_auth` schema before provisioning Neon Auth.",
			},
		);
	});

	test("status", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"status",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("status not configured", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"neon-auth",
				"status",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ mockDir: "neon-auth-not-configured" },
		);
	});

	test("disable", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"disable",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("disable with delete data", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"neon-auth",
				"disable",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
				"--delete-data",
			],
			{ mockDir: "neon-auth-delete-data" },
		);
	});

	// --- OAuth Provider ---

	test("oauth-provider list", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"oauth-provider",
			"list",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("oauth-provider add", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"oauth-provider",
			"add",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--provider-id",
			"google",
		]);
	});

	test("oauth-provider update", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"oauth-provider",
			"update",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--provider-id",
			"google",
			"--oauth-client-id",
			"my-client-id",
		]);
	});

	test("oauth-provider delete", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"oauth-provider",
			"delete",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--provider-id",
			"google",
		]);
	});

	describe("oauth-provider apple and microsoft", () => {
		const branchArgs = ["--project-id", "test", "--branch", "test_branch"];
		const providerBodies = (requests: RecordedRequest[], method: string) =>
			requests
				.filter(
					(r) =>
						r.method === method &&
						r.path.includes("/oauth_providers"),
				)
				.map((r) => r.body);
		const withSecretFile = async (
			contents: string,
			run: (path: string) => Promise<void>,
		) => {
			const dir = mkdtempSync(join(tmpdir(), "neon-oauth-secret-"));
			try {
				const path = join(dir, "AuthKey_ABC123DEFG.p8");
				writeFileSync(path, contents);
				await run(path);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		};

		test("add microsoft passes the tenant ID and prints the callback URL", async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			await testCliCommand(
				[
					"neon-auth",
					"oauth-provider",
					"add",
					...branchArgs,
					"--provider-id",
					"microsoft",
					"--oauth-client-id",
					"ms-client",
					"--oauth-client-secret",
					"ms-secret",
					"--microsoft-tenant-id",
					"contoso.onmicrosoft.com",
				],
				{ output: "table", onRequest: (r) => requests.push(r) },
			);
			expect(providerBodies(requests, "POST")).toEqual([
				{
					id: "microsoft",
					client_id: "ms-client",
					client_secret: "ms-secret",
					microsoft_tenant_id: "contoso.onmicrosoft.com",
				},
			]);
		});

		test("add apple reads the private key from --oauth-client-secret-file and prints its key IDs", async ({
			testCliCommand,
		}) => {
			const pem =
				"-----BEGIN PRIVATE KEY-----\nMIGTAgEA\n-----END PRIVATE KEY-----";
			await withSecretFile(`${pem}\n`, async (path) => {
				const requests: RecordedRequest[] = [];
				await testCliCommand(
					[
						"neon-auth",
						"oauth-provider",
						"add",
						...branchArgs,
						"--provider-id",
						"apple",
						"--oauth-client-id",
						"com.example.services",
						"--oauth-client-secret-file",
						path,
						"--apple-team-id",
						"TEAM123456",
						"--apple-key-id",
						"ABC123DEFG",
					],
					{ output: "table", onRequest: (r) => requests.push(r) },
				);
				expect(providerBodies(requests, "POST")).toEqual([
					{
						id: "apple",
						client_id: "com.example.services",
						client_secret: pem,
						apple_team_id: "TEAM123456",
						apple_key_id: "ABC123DEFG",
					},
				]);
			});
		});

		test("update apple sends a rotated key together with its key ID", async ({
			testCliCommand,
		}) => {
			await withSecretFile("new-key", async (path) => {
				const requests: RecordedRequest[] = [];
				await testCliCommand(
					[
						"neon-auth",
						"oauth-provider",
						"update",
						...branchArgs,
						"--provider-id",
						"apple",
						"--oauth-client-secret-file",
						path,
						"--apple-key-id",
						"NEWKEY1234",
					],
					{ snapshot: false, onRequest: (r) => requests.push(r) },
				);
				expect(providerBodies(requests, "PATCH")).toEqual([
					{ client_secret: "new-key", apple_key_id: "NEWKEY1234" },
				]);
			});
		});

		test("update apple rejects a client secret change without --apple-key-id", async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			await testCliCommand(
				[
					"neon-auth",
					"oauth-provider",
					"update",
					...branchArgs,
					"--provider-id",
					"apple",
					"--oauth-client-secret",
					"new-key",
				],
				{
					code: 1,
					snapshot: false,
					stderr: "ERROR: Changing the apple client secret requires --apple-key-id, the Key ID of the new private key.",
					onRequest: (r) => requests.push(r),
				},
			);
			expect(providerBodies(requests, "PATCH")).toEqual([]);
		});

		test("--oauth-client-secret-file conflicts with --oauth-client-secret", async ({
			testCliCommand,
		}) => {
			await testCliCommand(
				[
					"neon-auth",
					"oauth-provider",
					"add",
					...branchArgs,
					"--provider-id",
					"github",
					"--oauth-client-secret",
					"a",
					"--oauth-client-secret-file",
					"/dev/null",
				],
				{
					code: 1,
					snapshot: false,
					stderr: expect.stringContaining("mutually exclusive"),
				},
			);
		});

		test("--oauth-client-secret-file reports a missing file before any API call", async ({
			testCliCommand,
		}) => {
			await testCliCommand(
				[
					"neon-auth",
					"oauth-provider",
					"add",
					...branchArgs,
					"--provider-id",
					"github",
					"--oauth-client-secret-file",
					"/nonexistent/secret.txt",
				],
				{
					code: 1,
					snapshot: false,
					stderr: expect.stringContaining(
						"Could not read --oauth-client-secret-file /nonexistent/secret.txt",
					),
				},
			);
		});
	});

	// --- Domain ---

	test("domain list", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"domain",
			"list",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("domain add", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"domain",
			"add",
			"https://myapp.com",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("domain delete", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"domain",
			"delete",
			"https://example.com",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	// --- Config: Email and Password ---

	test("email-password get", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"email-password",
			"get",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("email-password update", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"email-password",
			"update",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--enabled",
			"--require-email-verification",
		]);
	});

	// --- Config: Email Provider ---

	test("email-provider get", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"email-provider",
			"get",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("email-provider update", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"email-provider",
			"update",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--type",
			"shared",
		]);
	});

	test("email-provider test", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"email-provider",
			"test",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--recipient-email",
			"user@test.com",
		]);
	});

	test("email-provider test human output", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"email-provider",
				"test",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
				"--recipient-email",
				"user@test.com",
			],
			{ output: "table" },
		);
	});

	test("email-provider test rejects flags after --", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"email-provider",
				"test",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
				"--recipient-email",
				"user@test.com",
				"--",
				"--host",
				"smtp.test.com",
			],
			{
				code: 1,
				stderr: expect.stringContaining(
					"takes no arguments after `--`",
				),
			},
		);
	});

	test("email-provider test rejected smtp flags", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"email-provider",
				"test",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
				"--recipient-email",
				"user@test.com",
				"--host",
				"smtp.test.com",
			],
			{
				code: 1,
				stderr: expect.stringContaining("Unknown argument: host"),
			},
		);
	});

	test("email-provider test relay refusal", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"email-provider",
				"test",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
				"--recipient-email",
				"fail@test.com",
			],
			{
				code: 1,
				stderr: expect.stringContaining(
					"Test email could NOT be sent to fail@test.com using the custom SMTP provider saved on this branch.",
				),
			},
		);
	});

	// --- Allow localhost ---

	test("domain allow-localhost get", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"domain",
			"allow-localhost",
			"get",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("domain allow-localhost enable", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"domain",
			"allow-localhost",
			"enable",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("domain allow-localhost disable", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"domain",
			"allow-localhost",
			"disable",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	// --- Config: Organization ---

	test("organization get", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"organization",
			"get",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("organization update", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"organization",
			"update",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--enabled",
			"--limit",
			"10",
		]);
	});

	// --- Config: OAuth server ---

	test("oauth-server get", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"oauth-server",
			"get",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("oauth-server update", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"oauth-server",
			"update",
			"--enabled",
			"--login-page",
			"https://app.example.com/login",
			"--mcp-resource",
			"https://example.com/mcp",
			"--mcp-client-id-metadata-documents",
			"--resources",
			"https://api.example.com",
			"https://api2.example.com",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	const mcpPatchBodies = (requests: RecordedRequest[]) =>
		requests
			.filter(
				(r) =>
					r.method === "PATCH" &&
					r.path.endsWith("/plugins/oauth-provider"),
			)
			.map((r) => r.body);

	test("oauth-server update fills only the stored MCP resource", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"oauth-server",
				"update",
				"--mcp-client-id-metadata-documents",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ onRequest: (r) => requests.push(r) },
		);
		expect(mcpPatchBodies(requests)).toEqual([
			{
				mcp: {
					resource: "https://stored.example.com/mcp",
					client_id_metadata_documents: true,
				},
			},
		]);
	});

	test("oauth-server update with only --mcp-resource makes no GET", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"oauth-server",
				"update",
				"--mcp-resource",
				"https://new/mcp",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ onRequest: (r) => requests.push(r) },
		);
		expect(
			requests.filter(
				(r) =>
					r.method === "GET" &&
					r.path.endsWith("/plugins/oauth-provider"),
			),
		).toEqual([]);
		expect(mcpPatchBodies(requests)).toEqual([
			{ mcp: { resource: "https://new/mcp" } },
		]);
	});

	test("oauth-server update with every MCP flag skips reading the stored config", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"oauth-server",
				"update",
				"--mcp-resource",
				"https://new.example.com/mcp",
				"--mcp-client-id-metadata-documents",
				"--no-mcp-dynamic-registration",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ onRequest: (r) => requests.push(r) },
		);
		expect(
			requests.filter(
				(r) =>
					r.method === "GET" &&
					r.path.endsWith("/plugins/oauth-provider"),
			),
		).toEqual([]);
		expect(mcpPatchBodies(requests)).toEqual([
			{
				mcp: {
					resource: "https://new.example.com/mcp",
					dynamic_registration: false,
					client_id_metadata_documents: true,
				},
			},
		]);
	});

	const BASE = ["--project-id", "test", "--branch", "test_branch"];
	const serverArgs = (...rest: string[]) => [
		"neon-auth",
		"config",
		"oauth-server",
		...rest,
		...BASE,
	];
	const clientArgs = (...rest: string[]) => [
		"neon-auth",
		"oauth-client",
		...rest,
		...BASE,
	];

	test("oauth-server update rejects an empty MCP resource before any request", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(serverArgs("update", "--mcp-resource", ""), {
			code: 1,
			stderr: "ERROR: --mcp-resource must not be empty. To remove the MCP configuration, use --no-mcp.",
			onRequest: (r) => requests.push(r),
		});
		expect(requests).toEqual([]);
	});

	test("oauth-server update rejects empty --resources before any request", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(serverArgs("update", "--resources"), {
			code: 1,
			stderr: "ERROR: --resources must list at least one URL. To remove resources, use `neon-auth config oauth-server resource remove <url...>`.",
			onRequest: (r) => requests.push(r),
		});
		expect(requests).toEqual([]);
	});

	test("oauth-server update sends login and consent pages without mcp or resources", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"update",
				"--login-page",
				"https://app.example.com/new-login",
				"--consent-page",
				"https://app.example.com/new-consent",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(patchBodies(requests)).toEqual([
			{
				login_page: "https://app.example.com/new-login",
				consent_page: "https://app.example.com/new-consent",
			},
		]);
	});

	const oauthProviderGets = (requests: RecordedRequest[]) =>
		requests.filter(
			(r) =>
				r.method === "GET" &&
				r.path.endsWith("/plugins/oauth-provider"),
		);

	test("oauth-server update --resources dedupes URLs", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"update",
				"--resources",
				"https://b.example.com",
				"https://a.example.com",
				"https://b.example.com",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(mcpPatchBodies(requests)).toEqual([
			{
				resources: [
					{ identifier: "https://b.example.com" },
					{ identifier: "https://a.example.com" },
				],
			},
		]);
	});

	test("oauth-server update --resources rejects the stored MCP resource", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"update",
				"--resources",
				"https://stored.example.com/mcp",
			),
			{
				code: 1,
				stderr: "ERROR: https://stored.example.com/mcp is the MCP resource and cannot also be a protected resource.",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(mcpPatchBodies(requests)).toEqual([]);
	});

	test("oauth-server update --resources rejects the --mcp-resource value without reading the stored config", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"update",
				"--resources",
				"https://new.example.com/mcp",
				"--mcp-resource",
				"https://new.example.com/mcp",
				"--mcp-client-id-metadata-documents",
				"--no-mcp-dynamic-registration",
			),
			{
				code: 1,
				stderr: "ERROR: https://new.example.com/mcp is the MCP resource and cannot also be a protected resource.",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(oauthProviderGets(requests)).toEqual([]);
		expect(mcpPatchBodies(requests)).toEqual([]);
	});

	test("oauth-server update --resources reads the stored config once when it also merges MCP flags", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"update",
				"--resources",
				"https://stored.example.com/mcp",
				"--mcp-client-id-metadata-documents",
			),
			{
				code: 1,
				stderr: "ERROR: https://stored.example.com/mcp is the MCP resource and cannot also be a protected resource.",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(oauthProviderGets(requests)).toHaveLength(1);
		expect(mcpPatchBodies(requests)).toEqual([]);
	});

	test("oauth-server update --resources with --no-mcp skips the MCP collision check", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"update",
				"--resources",
				"https://stored.example.com/mcp",
				"--no-mcp",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(oauthProviderGets(requests)).toEqual([]);
		expect(mcpPatchBodies(requests)).toEqual([
			{
				mcp: { resource: "" },
				resources: [{ identifier: "https://stored.example.com/mcp" }],
			},
		]);
	});

	test("oauth-server update sets up MCP for the first time", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"update",
				"--enabled",
				"--mcp-resource",
				"https://example.com/mcp",
				"--mcp-client-id-metadata-documents",
			),
			{
				mockDir: "neon-auth-oauth-server-no-mcp",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(mcpPatchBodies(requests)).toEqual([
			{
				enabled: true,
				mcp: {
					resource: "https://example.com/mcp",
					client_id_metadata_documents: true,
				},
			},
		]);
	});

	test("oauth-server update --no-mcp clears the MCP configuration", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(serverArgs("update", "--no-mcp"), {
			onRequest: (r) => requests.push(r),
		});
		expect(mcpPatchBodies(requests)).toEqual([{ mcp: { resource: "" } }]);
		expect(
			requests.filter(
				(r) =>
					r.method === "GET" &&
					r.path.endsWith("/plugins/oauth-provider"),
			),
		).toEqual([]);
	});

	test("oauth-server update --no-mcp conflicts with the other MCP flags", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"update",
				"--no-mcp",
				"--mcp-resource",
				"https://example.com/mcp",
			),
			{
				code: 1,
				stderr: "ERROR: --no-mcp cannot be combined with --mcp-resource, --mcp-client-id-metadata-documents or --mcp-dynamic-registration.",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(requests).toEqual([]);
	});

	test("oauth-server update rejects --mcp", async ({ testCliCommand }) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(serverArgs("update", "--mcp"), {
			code: 1,
			stderr: "ERROR: --mcp cannot be enabled. Configure MCP with --mcp-resource <url>, or remove it with --no-mcp.",
			onRequest: (r) => requests.push(r),
		});
		expect(requests).toEqual([]);
	});

	test("oauth-server update rejects --no-resources before any request", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(serverArgs("update", "--no-resources"), {
			code: 1,
			stderr: "ERROR: --no-resources is not supported. To remove resources, use `neon-auth config oauth-server resource remove <url...>`.",
			onRequest: (r) => requests.push(r),
		});
		expect(requests).toEqual([]);
	});

	test("oauth-server update rejects --no-mcp-resource before any request", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(serverArgs("update", "--no-mcp-resource"), {
			code: 1,
			stderr: "ERROR: --no-mcp-resource is not supported. To remove the MCP configuration, use --no-mcp.",
			onRequest: (r) => requests.push(r),
		});
		expect(requests).toEqual([]);
	});

	for (const [flag, label] of [
		["login-page", "login page"],
		["consent-page", "consent page"],
	]) {
		test(`oauth-server update rejects --no-${flag} before any request`, async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			await testCliCommand(serverArgs("update", `--no-${flag}`), {
				code: 1,
				stderr: `ERROR: --no-${flag} is not supported. Pass --${flag} <url>.`,
				onRequest: (r) => requests.push(r),
			});
			expect(requests, label).toEqual([]);
		});
	}

	test("oauth-server update lets --resources reuse the stored MCP resource when --mcp-resource replaces it", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"update",
				"--mcp-resource",
				"https://new.example.com/mcp",
				"--resources",
				"https://stored.example.com/mcp",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(mcpPatchBodies(requests)).toEqual([
			{
				mcp: {
					resource: "https://new.example.com/mcp",
				},
				resources: [{ identifier: "https://stored.example.com/mcp" }],
			},
		]);
	});

	test("oauth-server update without any flag fails", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"oauth-server",
				"update",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{
				code: 1,
				stderr: "ERROR: Nothing to update. Pass at least one of --enabled, --login-page, --consent-page, --resources, --no-mcp, --mcp-resource, --mcp-client-id-metadata-documents.",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(requests).toEqual([]);
	});

	test("oauth-server get table", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"oauth-server",
				"get",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ outputTable: true },
		);
	});

	test("oauth-server update table", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"oauth-server",
				"update",
				"--enabled",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ outputTable: true },
		);
	});

	test("oauth-server update without a stored MCP resource fails", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"oauth-server",
				"update",
				"--mcp-client-id-metadata-documents",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{
				mockDir: "neon-auth-oauth-server-no-mcp",
				code: 1,
				stderr: "ERROR: No MCP resource is configured yet. Pass --mcp-resource <url> together with the other --mcp-* flags.",
			},
		);
	});

	test("oauth-server update disables dynamic registration", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"oauth-server",
				"update",
				"--no-mcp-dynamic-registration",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{
				onRequest: (r) => requests.push(r),
				stderr: "WARNING: --mcp-dynamic-registration is deprecated. Use --mcp-client-id-metadata-documents instead.",
			},
		);
		expect(mcpPatchBodies(requests)).toEqual([
			{
				mcp: {
					resource: "https://stored.example.com/mcp",
					dynamic_registration: false,
				},
			},
		]);
	});

	test("oauth-server update sends no mcp without an mcp flag", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			[
				"neon-auth",
				"config",
				"oauth-server",
				"update",
				"--no-enabled",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ onRequest: (r) => requests.push(r) },
		);
		expect(oauthProviderGets(requests)).toEqual([]);
		expect(mcpPatchBodies(requests)).toEqual([{ enabled: false }]);
	});

	// --- OAuth server resources ---

	const RESOURCES_MOCK = "neon-auth-oauth-server-resources";
	const patchBodies = (requests: RecordedRequest[]) =>
		requests.filter((r) => r.method === "PATCH").map((r) => r.body);

	test("resource list", async ({ testCliCommand }) => {
		await testCliCommand(serverArgs("resource", "list"));
	});

	test("resource list table", async ({ testCliCommand }) => {
		await testCliCommand(serverArgs("resource", "list"), {
			outputTable: true,
		});
	});

	test("resource list when empty", async ({ testCliCommand }) => {
		await testCliCommand(serverArgs("resource", "list"), {
			mockDir: "neon-auth-oauth-server-resources-empty",
			outputTable: true,
			stdout: "No protected resources are configured",
		});
	});

	test("resource add sends the full list without mcp", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"resource",
				"add",
				"https://new.example.com",
				"https://new2.example.com",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(patchBodies(requests)).toEqual([
			{
				resources: [
					{ identifier: "https://api.example.com" },
					{ identifier: "https://new.example.com" },
					{ identifier: "https://new2.example.com" },
				],
			},
		]);
	});

	test("resource add skips URLs that are already configured", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"resource",
				"add",
				"https://api.example.com",
				"https://new.example.com",
			),
			{
				stderr: "WARNING: Already configured, skipped: https://api.example.com",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(patchBodies(requests)).toEqual([
			{
				resources: [
					{ identifier: "https://api.example.com" },
					{ identifier: "https://new.example.com" },
				],
			},
		]);
	});

	test("resource add sends no PATCH when every URL is already configured", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs("resource", "add", "https://api.example.com"),
			{
				stderr: "WARNING: Already configured, skipped: https://api.example.com",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(patchBodies(requests)).toEqual([]);
	});

	test("resource add dedupes URLs repeated in the input", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"resource",
				"add",
				"https://new.example.com",
				"https://new.example.com",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(patchBodies(requests)).toEqual([
			{
				resources: [
					{ identifier: "https://api.example.com" },
					{ identifier: "https://new.example.com" },
				],
			},
		]);
	});

	test("resource add trims the URL before sending", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs("resource", "add", " https://c.example.com "),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(patchBodies(requests)).toEqual([
			{
				resources: [
					{ identifier: "https://api.example.com" },
					{ identifier: "https://c.example.com" },
				],
			},
		]);
	});

	test("resource remove trims the URL before matching", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs("resource", "remove", "https://a.example.com "),
			{ mockDir: RESOURCES_MOCK, onRequest: (r) => requests.push(r) },
		);
		expect(patchBodies(requests)).toEqual([
			{ resources: [{ identifier: "https://b.example.com" }] },
		]);
	});

	test("oauth-server update trims its URL flags", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"update",
				"--login-page",
				" https://login.example.com ",
				"--consent-page",
				" https://consent.example.com ",
				"--mcp-resource",
				" https://mcp.example.com ",
				"--resources",
				" https://r.example.com ",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(patchBodies(requests)).toEqual([
			{
				login_page: "https://login.example.com",
				consent_page: "https://consent.example.com",
				mcp: { resource: "https://mcp.example.com" },
				resources: [{ identifier: "https://r.example.com" }],
			},
		]);
	});

	test("resource add rejects the MCP resource", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs("resource", "add", "https://stored.example.com/mcp"),
			{
				code: 1,
				stderr: "ERROR: https://stored.example.com/mcp is the MCP resource and cannot also be a protected resource.",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(patchBodies(requests)).toEqual([]);
	});

	test("resource remove warns about linked clients", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs("resource", "remove", "https://api.example.com"),
			{
				stderr: 'WARNING: Clients still linked to a removed resource: "My MCP client" (client-abc123). Their token requests for that resource may fail until it is added again.',
				onRequest: (r) => requests.push(r),
			},
		);
		expect(patchBodies(requests)).toEqual([{ resources: [] }]);
		expect(
			requests
				.filter((r) => r.path.includes("/auth/"))
				.map((r) => `${r.method} ${r.path}`),
		).toEqual([
			expect.stringMatching(/^GET .*\/auth\/plugins\/oauth-provider$/),
			expect.stringMatching(/^PATCH .*\/auth\/plugins\/oauth-provider$/),
			expect.stringMatching(/^GET .*\/auth\/oauth-provider\/clients$/),
		]);
	});

	test("resource remove warns and succeeds when the client lookup fails", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs("resource", "remove", "https://a.example.com"),
			{
				mockDir: "neon-auth-oauth-server-resources-clients-fail",
				stderr: "WARNING: Removed, but could not check for clients still linked to it.",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(patchBodies(requests)).toEqual([
			{ resources: [{ identifier: "https://b.example.com" }] },
		]);
		expect(
			requests
				.filter((r) => r.path.includes("/auth/"))
				.map((r) => `${r.method} ${r.path}`),
		).toEqual([
			expect.stringMatching(/^GET .*\/auth\/plugins\/oauth-provider$/),
			expect.stringMatching(/^PATCH .*\/auth\/plugins\/oauth-provider$/),
			expect.stringMatching(/^GET .*\/auth\/oauth-provider\/clients$/),
		]);
	});

	test("resource remove does not warn when no client is linked", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs("resource", "remove", "https://b.example.com"),
			{
				mockDir: RESOURCES_MOCK,
				stderr: "",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(patchBodies(requests)).toEqual([
			{ resources: [{ identifier: "https://a.example.com" }] },
		]);
	});

	test("resource remove does not warn about linked clients when the PATCH fails", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs("resource", "remove", "https://a.example.com"),
			{
				mockDir: "neon-auth-oauth-server-resources-patch-fails",
				code: 1,
				stderr: "ERROR: Resource update rejected",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(patchBodies(requests)).toHaveLength(1);
		expect(
			requests.filter((r) =>
				r.path.endsWith("/auth/oauth-provider/clients"),
			),
		).toEqual([]);
	});

	test("resource remove skips URLs that are not configured", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs(
				"resource",
				"remove",
				"https://nope.example.com",
				"https://b.example.com",
			),
			{
				mockDir: RESOURCES_MOCK,
				stderr: "WARNING: Not configured, skipped: https://nope.example.com",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(patchBodies(requests)).toEqual([
			{ resources: [{ identifier: "https://a.example.com" }] },
		]);
	});

	test("resource remove with nothing to remove sends no PATCH and skips the client lookup", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			serverArgs("resource", "remove", "https://nope.example.com"),
			{
				stderr: "WARNING: Not configured, skipped: https://nope.example.com",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(patchBodies(requests)).toEqual([]);
		expect(
			requests.filter((r) =>
				r.path.endsWith("/auth/oauth-provider/clients"),
			),
		).toEqual([]);
	});

	// --- OAuth clients ---

	test("oauth-client list", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"oauth-client",
			"list",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("oauth-client create", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"neon-auth",
				"oauth-client",
				"create",
				"--name",
				"My MCP client",
				"--type",
				"confidential",
				"--redirect-uris",
				"https://app.example.com/callback",
				"--resources",
				"https://api.example.com",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{
				outputTable: true,
				stderr: "WARNING: Store this secret now: it is not shown again.",
			},
		);
	});

	test("oauth-client create json includes the secret", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"neon-auth",
			"oauth-client",
			"create",
			"--name",
			"My MCP client",
			"--type",
			"confidential",
			"--redirect-uris",
			"https://app.example.com/callback",
			"--resources",
			"https://api.example.com",
			"-o",
			"json",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("oauth-client create public has no secret", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"neon-auth",
				"oauth-client",
				"create",
				"--name",
				"SPA",
				"--type",
				"public",
				"--redirect-uris",
				"https://spa.example.com/cb",
				"--resources",
				"https://api.example.com",
				"--skip-consent",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ outputTable: true, stderr: "" },
		);
	});

	const clientPostBodies = (requests: RecordedRequest[]) =>
		requests.filter((r) => r.method === "POST").map((r) => r.body);

	for (const flag of ["--resources", "--redirect-uris"]) {
		test(`oauth-client create rejects empty ${flag} before any request`, async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			const given = {
				"--redirect-uris": "https://app.example.com/callback",
				"--resources": "https://api.example.com",
			};
			const other =
				flag === "--resources" ? "--redirect-uris" : "--resources";
			await testCliCommand(
				clientArgs(
					"create",
					"--name",
					"App",
					"--type",
					"public",
					flag,
					other,
					given[other],
				),
				{
					code: 1,
					stderr: `ERROR: ${flag} must list at least one value.`,
					onRequest: (r) => requests.push(r),
				},
			);
			expect(requests).toEqual([]);
		});
	}

	test("oauth-client create dedupes redirect URIs and resources", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs(
				"create",
				"--name",
				"App",
				"--type",
				"public",
				"--redirect-uris",
				"https://app.example.com/cb",
				"https://app.example.com/cb",
				"--resources",
				"https://api.example.com",
				"https://api.example.com",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(clientPostBodies(requests)).toEqual([
			{
				name: "App",
				type: "public",
				redirect_uris: ["https://app.example.com/cb"],
				resources: ["https://api.example.com"],
			},
		]);
	});

	test("oauth-client create trims redirect URIs and resources", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs(
				"create",
				"--name",
				"App",
				"--type",
				"public",
				"--redirect-uris",
				" https://app.example.com/cb ",
				"https://app.example.com/cb",
				"--resources",
				" https://api.example.com ",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(clientPostBodies(requests)).toEqual([
			{
				name: "App",
				type: "public",
				redirect_uris: ["https://app.example.com/cb"],
				resources: ["https://api.example.com"],
			},
		]);
	});

	test("oauth-client create trims the name", async ({ testCliCommand }) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs(
				"create",
				"--name",
				"  App  ",
				"--type",
				"public",
				"--redirect-uris",
				"https://app.example.com/cb",
				"--resources",
				"https://api.example.com",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(clientPostBodies(requests)).toEqual([
			{
				name: "App",
				type: "public",
				redirect_uris: ["https://app.example.com/cb"],
				resources: ["https://api.example.com"],
			},
		]);
	});

	for (const name of ["", "  "]) {
		test(`oauth-client create rejects blank --name "${name}" before any request`, async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			await testCliCommand(
				clientArgs(
					"create",
					"--name",
					name,
					"--type",
					"public",
					"--redirect-uris",
					"https://app.example.com/cb",
					"--resources",
					"https://api.example.com",
				),
				{
					code: 1,
					stderr: "ERROR: --name must not be empty.",
					onRequest: (r) => requests.push(r),
				},
			);
			expect(requests).toEqual([]);
		});

		test(`oauth-client update rejects blank --name "${name}" before any request`, async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			await testCliCommand(
				clientArgs("update", "client-abc123", "--name", name),
				{
					code: 1,
					stderr: "ERROR: --name must not be empty.",
					onRequest: (r) => requests.push(r),
				},
			);
			expect(requests).toEqual([]);
		});
	}

	test("oauth-client create rejects --no-name before any request", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs(
				"create",
				"--no-name",
				"--type",
				"public",
				"--redirect-uris",
				"https://app.example.com/cb",
				"--resources",
				"https://api.example.com",
			),
			{
				code: 1,
				stderr: "ERROR: --no-name is not supported. Pass --name <name>.",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(requests).toEqual([]);
	});

	test("oauth-client update rejects --no-name before any request", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs("update", "client-abc123", "--no-name"),
			{
				code: 1,
				stderr: "ERROR: --no-name is not supported. Pass --name <name>.",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(requests).toEqual([]);
	});

	test("oauth-client get", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"oauth-client",
			"get",
			"client-abc123",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	const clientPatchBodies = (requests: RecordedRequest[]) =>
		requests.filter((r) => r.method === "PATCH").map((r) => r.body);

	test("oauth-client update", async ({ testCliCommand }) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs(
				"update",
				"client-abc123",
				"--name",
				"Renamed",
				"--disabled",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(clientPatchBodies(requests)).toEqual([
			{ name: "Renamed", disabled: true },
		]);
	});

	test("oauth-client update trims the name", async ({ testCliCommand }) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs("update", "client-abc123", "--name", "  Renamed  "),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(clientPatchBodies(requests)).toEqual([{ name: "Renamed" }]);
	});

	test("oauth-client update trims and dedupes redirect URIs and resources", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs(
				"update",
				"client-abc123",
				"--redirect-uris",
				" https://app.example.com/cb ",
				"https://app.example.com/cb",
				"https://app.example.com/other",
				"--resources",
				" https://api.example.com ",
				"https://api.example.com",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(clientPatchBodies(requests)).toEqual([
			{
				redirect_uris: [
					"https://app.example.com/cb",
					"https://app.example.com/other",
				],
				resources: ["https://api.example.com"],
			},
		]);
	});

	test("oauth-client update --no-disabled re-enables the client", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs("update", "client-abc123", "--no-disabled"),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(clientPatchBodies(requests)).toEqual([{ disabled: false }]);
	});

	test("oauth-client update dedupes redirect URIs and resources", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs(
				"update",
				"client-abc123",
				"--redirect-uris",
				"https://app.example.com/cb",
				"https://app.example.com/cb",
				"--resources",
				"https://api.example.com",
				"https://api.example.com",
			),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(clientPatchBodies(requests)).toEqual([
			{
				redirect_uris: ["https://app.example.com/cb"],
				resources: ["https://api.example.com"],
			},
		]);
	});

	for (const flag of ["--resources", "--redirect-uris"]) {
		test(`oauth-client update rejects empty ${flag} before any request`, async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			await testCliCommand(clientArgs("update", "client-abc123", flag), {
				code: 1,
				stderr: `ERROR: ${flag} must list at least one value.`,
				onRequest: (r) => requests.push(r),
			});
			expect(requests).toEqual([]);
		});
	}

	for (const blank of ["", "  "]) {
		test(`oauth-server update --resources rejects blank value "${blank}" before any request`, async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			await testCliCommand(serverArgs("update", "--resources", blank), {
				code: 1,
				stderr: "ERROR: --resources must not contain empty values.",
				onRequest: (r) => requests.push(r),
			});
			expect(requests).toEqual([]);
		});

		test(`oauth-server update --mcp-resource rejects blank value "${blank}" before any request`, async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			await testCliCommand(
				serverArgs("update", "--mcp-resource", blank),
				{
					code: 1,
					stderr: "ERROR: --mcp-resource must not be empty. To remove the MCP configuration, use --no-mcp.",
					onRequest: (r) => requests.push(r),
				},
			);
			expect(requests).toEqual([]);
		});

		for (const flag of ["--login-page", "--consent-page"]) {
			test(`oauth-server update ${flag} rejects blank value "${blank}" before any request`, async ({
				testCliCommand,
			}) => {
				const requests: RecordedRequest[] = [];
				await testCliCommand(serverArgs("update", flag, blank), {
					code: 1,
					stderr: `ERROR: ${flag} must not be empty.`,
					onRequest: (r) => requests.push(r),
				});
				expect(requests).toEqual([]);
			});
		}

		for (const action of ["add", "remove"]) {
			test(`resource ${action} rejects blank URL "${blank}" before any request`, async ({
				testCliCommand,
			}) => {
				const requests: RecordedRequest[] = [];
				await testCliCommand(
					serverArgs(
						"resource",
						action,
						"https://ok.example.com",
						blank,
					),
					{
						code: 1,
						stderr: "ERROR: URLs must not be empty.",
						onRequest: (r) => requests.push(r),
					},
				);
				expect(requests).toEqual([]);
			});
		}

		for (const flag of ["--resources", "--redirect-uris"]) {
			test(`oauth-client create rejects blank ${flag} "${blank}" before any request`, async ({
				testCliCommand,
			}) => {
				const requests: RecordedRequest[] = [];
				const given: Record<string, string> = {
					"--redirect-uris": "https://app.example.com/callback",
					"--resources": "https://api.example.com",
				};
				const other =
					flag === "--resources" ? "--redirect-uris" : "--resources";
				await testCliCommand(
					clientArgs(
						"create",
						"--name",
						"App",
						"--type",
						"public",
						flag,
						blank,
						other,
						given[other],
					),
					{
						code: 1,
						stderr: `ERROR: ${flag} must not contain empty values.`,
						onRequest: (r) => requests.push(r),
					},
				);
				expect(requests).toEqual([]);
			});

			test(`oauth-client update rejects blank ${flag} "${blank}" before any request`, async ({
				testCliCommand,
			}) => {
				const requests: RecordedRequest[] = [];
				await testCliCommand(
					clientArgs("update", "client-abc123", flag, blank),
					{
						code: 1,
						stderr: `ERROR: ${flag} must not contain empty values.`,
						onRequest: (r) => requests.push(r),
					},
				);
				expect(requests).toEqual([]);
			});
		}
	}

	for (const flag of ["--resources", "--redirect-uris"]) {
		test(`oauth-client create rejects --no-${flag.slice(2)} before any request`, async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			const given = {
				"--redirect-uris": "https://app.example.com/callback",
				"--resources": "https://api.example.com",
			};
			const other =
				flag === "--resources" ? "--redirect-uris" : "--resources";
			await testCliCommand(
				clientArgs(
					"create",
					"--name",
					"App",
					"--type",
					"public",
					`--no-${flag.slice(2)}`,
					other,
					given[other],
				),
				{
					code: 1,
					stderr: `ERROR: --no-${flag.slice(2)} is not supported. ${flag} must list at least one value.`,
					onRequest: (r) => requests.push(r),
				},
			);
			expect(requests).toEqual([]);
		});

		test(`oauth-client update rejects --no-${flag.slice(2)} before any request`, async ({
			testCliCommand,
		}) => {
			const requests: RecordedRequest[] = [];
			await testCliCommand(
				clientArgs("update", "client-abc123", `--no-${flag.slice(2)}`),
				{
					code: 1,
					stderr: `ERROR: --no-${flag.slice(2)} is not supported. ${flag} must list at least one value.`,
					onRequest: (r) => requests.push(r),
				},
			);
			expect(requests).toEqual([]);
		});
	}

	test("oauth-client update sends skip_consent true", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs("update", "client-abc123", "--skip-consent"),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(clientPatchBodies(requests)).toEqual([{ skip_consent: true }]);
	});

	test("oauth-client update --no-skip-consent sends skip_consent false", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			clientArgs("update", "client-abc123", "--no-skip-consent"),
			{ onRequest: (r) => requests.push(r) },
		);
		expect(clientPatchBodies(requests)).toEqual([{ skip_consent: false }]);
	});

	test("oauth-client delete", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"oauth-client",
			"delete",
			"client-abc123",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("oauth-client rotate-secret", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"neon-auth",
				"oauth-client",
				"rotate-secret",
				"client-abc123",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{
				outputTable: true,
				stderr: "WARNING: Store this secret now: it is not shown again.",
			},
		);
	});

	for (const output of ["json", "yaml"] as const) {
		test(`oauth-client rotate-secret ${output} includes the secret`, async ({
			testCliCommand,
		}) => {
			await testCliCommand(
				[
					"neon-auth",
					"oauth-client",
					"rotate-secret",
					"client-abc123",
					"-o",
					output,
					"--project-id",
					"test",
					"--branch",
					"test_branch",
				],
				{
					stderr: "WARNING: Store this secret now: it is not shown again.",
				},
			);
		});
	}

	test("oauth-client list reports when there are no clients", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"neon-auth",
				"oauth-client",
				"list",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ mockDir: "neon-auth-oauth-clients-empty", outputTable: true },
		);
	});

	test("oauth-client update without any flag fails", async ({
		testCliCommand,
	}) => {
		const requests: RecordedRequest[] = [];
		await testCliCommand(
			[
				"neon-auth",
				"oauth-client",
				"update",
				"client-abc123",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{
				code: 1,
				stderr: "ERROR: Nothing to update. Pass at least one of --name, --redirect-uris, --resources, --skip-consent, --disabled.",
				onRequest: (r) => requests.push(r),
			},
		);
		expect(requests).toEqual([]);
	});

	// --- Config: Webhook ---

	test("webhook get", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"webhook",
			"get",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("webhook update", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"config",
			"webhook",
			"update",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--enabled",
			"--url",
			"https://hooks.test.com/webhook",
			"--enabled-events",
			"user.created",
		]);
	});

	// --- Plugins ---

	test("plugins list", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"plugins",
			"list",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("plugins get", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"plugins",
			"get",
			"organization",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	// --- User ---

	test("user create", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"user",
			"create",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--email",
			"test@example.com",
			"--name",
			"Test User",
		]);
	});

	test("user delete", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"user",
			"delete",
			"test-user-id",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("user set-role", async ({ testCliCommand }) => {
		await testCliCommand([
			"neon-auth",
			"user",
			"set-role",
			"test-user-id",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--roles",
			"admin",
		]);
	});

	// --- Human output ---

	const statusArgs = (branch: string) => [
		"neon-auth",
		"status",
		"--project-id",
		"test",
		"--branch",
		branch,
	];

	test("status table names the branch", async ({ testCliCommand }) => {
		await testCliCommand(statusArgs("test_branch"), { output: "table" });
	});

	test("status table shows an explicit branch id as given", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			statusArgs("br-sunny-branch-123456"),
			{ output: "table", snapshot: false },
		);
		expect(stdout).toMatch(/^ {2}Branch:\s+br-sunny-branch-123456$/m);
	});

	test("status JSON is the integration as returned", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(statusArgs("test_branch"), {
			output: "json",
			snapshot: false,
		});
		expect(JSON.parse(stdout)).toMatchObject(
			JSON.parse(
				readFileSync(
					"mocks/main/projects/test/branches/br-sunny-branch-123456/auth/GET.json",
					"utf8",
				),
			),
		);
	});

	test("blocks and messages honor NO_COLOR", async ({ testCliCommand }) => {
		const deleteArgs = [
			"neon-auth",
			"oauth-provider",
			"delete",
			"--provider-id",
			"google",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		];
		const branchArgs = ["--project-id", "test", "--branch", "test_branch"];
		for (const args of [
			statusArgs("test_branch"),
			deleteArgs,
			["neon-auth", "enable", ...branchArgs],
			["neon-auth", "oauth-provider", "list", ...branchArgs],
		]) {
			const colored = await testCliCommand(args, {
				output: "table",
				snapshot: false,
				env: { FORCE_COLOR: "1" },
			});
			expect(colored.stdout).toContain("\u001b[");
			const plain = await testCliCommand(args, {
				output: "table",
				snapshot: false,
				env: { FORCE_COLOR: "1", NO_COLOR: "1" },
			});
			expect(plain.stdout).not.toContain("\u001b[");
		}
	});
});
