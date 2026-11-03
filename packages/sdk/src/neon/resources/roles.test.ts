import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import { NeonAuthError, NeonClientError } from "../errors.js";

/**
 * The scoped `roles.create` path's error contract. The live e2e covers success and
 * Postgres rollbacks; these cover the outcomes a real server will not produce on demand.
 */
type Step = (url: URL) => Response | Promise<Response>;

function scopedClient(steps: Record<string, Step>) {
	const calls: string[] = [];
	const requests: Request[] = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			const key = `${request.method} ${url.pathname}`;
			calls.push(key);
			requests.push(request);
			const step = steps[key];
			if (!step) throw new Error(`unexpected request ${key}`);
			return step(url);
		},
	});
	return { neon, calls, requests };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const preflight: Record<string, Step> = {
	"GET /api/v2/projects/p/branches/br/databases": () =>
		json({ databases: [{ name: "neondb", owner_name: "neondb_owner" }] }),
	"GET /api/v2/projects/p/connection_uri": () =>
		json({
			uri: "postgresql://neondb_owner:pw@ep-x.c-1.us-east-2.aws.neon.tech/neondb",
		}),
};

const input = {
	projectId: "p",
	branchId: "br",
	name: "app_reader",
	access: "read_only",
} as const;

describe("roles.create with scoped access", () => {
	it("returns a connection-string auth failure as-is, before any SQL", async () => {
		const { neon, calls } = scopedClient({
			...preflight,
			"GET /api/v2/projects/p/connection_uri": () =>
				json({ message: "unauthorized" }, 401),
		});
		const { error } = await neon.postgres.roles.create(input);
		expect(error).toBeInstanceOf(NeonAuthError);
		expect(calls).not.toContain("POST /sql");
	});

	it("reports an uncertain outcome when the SQL request fails", async () => {
		const { neon } = scopedClient({
			...preflight,
			"POST /sql": () => {
				throw new TypeError("fetch failed");
			},
		});
		const { error } = await neon.postgres.roles.create(input);
		expect(error).toBeInstanceOf(NeonClientError);
		expect(error?.message).toContain(
			'Could not confirm whether role "app_reader" was created',
		);
	});

	it("reports an uncertain outcome when the SQL response has the wrong shape", async () => {
		const { neon } = scopedClient({
			...preflight,
			"POST /sql": () => json({ results: [] }),
		});
		const { error } = await neon.postgres.roles.create(input);
		expect(error?.message).toContain("without one result per statement");
	});

	it("says the role exists when the password reset fails after commit", async () => {
		const { neon, calls } = scopedClient({
			...preflight,
			"POST /sql": () =>
				json({
					results: Array.from({ length: 5 }, () => ({ rows: [] })),
				}),
			"POST /api/v2/projects/p/branches/br/roles/app_reader/reset_password":
				() => json({ message: "internal error" }, 500),
		});
		const { error } = await neon.postgres.roles.create(input);
		expect(error).toBeInstanceOf(NeonClientError);
		expect(error?.message).toContain(
			'Role "app_reader" was created with read_only access',
		);
		expect(error?.message).toContain("roles.resetPassword");
		expect(calls.at(-1)).toBe(
			"POST /api/v2/projects/p/branches/br/roles/app_reader/reset_password",
		);
	});

	it("sends the SQL to the region's api host without the API key or redirects", async () => {
		const { neon, requests } = scopedClient({
			...preflight,
			"POST /sql": () => json({ message: "boom", code: "42501" }, 400),
		});
		const { error } = await neon.postgres.roles.create(input);
		expect(error?.message).toContain("nothing was changed. Postgres: boom");
		const sql = requests.find((request) => request.url.endsWith("/sql"));
		expect(sql?.url).toBe("https://api.c-1.us-east-2.aws.neon.tech/sql");
		expect(sql?.headers.get("authorization")).toBeNull();
		expect(sql?.redirect).toBe("error");
		expect(sql?.headers.get("neon-connection-string")).toContain(
			"neondb_owner",
		);
	});
});
