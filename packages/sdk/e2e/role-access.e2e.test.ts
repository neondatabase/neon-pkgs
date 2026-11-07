import {
	createProject,
	deleteProject,
	uniqueProjectName,
} from "@neon/e2e-harness";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NeonApiError, type NeonClient } from "../src/index.js";
import { expectOk, makeClient } from "./helpers.js";

/**
 * `roles.create` with `access`: what the created role can and cannot do, checked by
 * logging in as it with `pg`, which shares no code with the SDK's SQL path.
 */
describe.sequential("e2e — @neon/sdk scoped roles against the real API", () => {
	let neon: NeonClient<false>;
	let projectId: string;
	let branchId: string;
	let ownerName: string;

	async function connect(roleName: string) {
		const uri = expectOk(
			await neon.postgres.connectionString({
				projectId,
				branchId,
				databaseName: "neondb",
				roleName,
				pooled: false,
			}),
		);
		const client = new pg.Client({ connectionString: uri });
		await client.connect();
		return client;
	}

	async function asOwner<T>(run: (client: pg.Client) => Promise<T>) {
		const client = await connect(ownerName);
		try {
			return await run(client);
		} finally {
			await client.end();
		}
	}

	async function sqlState(client: pg.Client, sql: string) {
		try {
			await client.query(sql);
			return "ok";
		} catch (error) {
			if (error instanceof Error && "code" in error) return error.code;
			throw error;
		}
	}

	async function attributes(roleName: string) {
		return asOwner(async (client) => {
			const { rows } = await client.query<{
				rolcanlogin: boolean;
				rolcreatedb: boolean;
				rolcreaterole: boolean;
				rolbypassrls: boolean;
				rolreplication: boolean;
				member_of: string[];
			}>(
				`select r.rolcanlogin, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolreplication,
				        array(select g.rolname::text from pg_auth_members m join pg_roles g on g.oid = m.roleid
				              where m.member = r.oid) as member_of
				   from pg_roles r where r.rolname = $1`,
				[roleName],
			);
			return rows[0];
		});
	}

	beforeAll(async () => {
		neon = makeClient();
		projectId = await createProject({
			name: uniqueProjectName("sdk-roles"),
		});
		branchId = expectOk(await neon.branches.getDefault({ projectId })).id;
		const [owner] = expectOk(
			await neon.postgres.roles.list({ projectId, branchId }),
		);
		if (!owner) throw new Error("project has no owner role");
		ownerName = owner.name;
		await asOwner((client) =>
			client.query(
				"create table before_t (id serial primary key, x int); insert into before_t (x) values (1)",
			),
		);
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	it("keeps admin as the default: the role joins neon_superuser", async () => {
		const created = expectOk(
			await neon.postgres.roles.create(
				{ projectId, branchId, name: "e2e_admin" },
				{ waitForReadiness: true },
			),
		);
		expect(typeof created.password).toBe("string");
		expect((await attributes("e2e_admin"))?.member_of).toContain(
			"neon_superuser",
		);
		expectOk(
			await neon.postgres.roles.delete(
				{ projectId, branchId, roleName: "e2e_admin" },
				{ waitForReadiness: true },
			),
		);
	});

	it("creates a read_only role that reads current and future tables and writes nothing", async () => {
		const created = expectOk(
			await neon.postgres.roles.create(
				{
					projectId,
					branchId,
					name: "App-Reader",
					access: "read_only",
				},
				{ waitForReadiness: true },
			),
		);
		expect(created.name).toBe("App-Reader");
		expect(
			expectOk(
				await neon.postgres.roles.password({
					projectId,
					branchId,
					roleName: "App-Reader",
				}),
			),
		).toBe(created.password);
		expect(await attributes("App-Reader")).toEqual({
			rolcanlogin: true,
			rolcreatedb: false,
			rolcreaterole: false,
			rolbypassrls: false,
			rolreplication: false,
			member_of: [],
		});

		await asOwner((client) =>
			client.query(
				"create table after_t (id serial primary key, x int); insert into after_t (x) values (1)",
			),
		);
		const reader = await connect("App-Reader");
		try {
			expect(
				(await reader.query("select count(*)::int as n from before_t"))
					.rows,
			).toEqual([{ n: 1 }]);
			expect(
				(await reader.query("select count(*)::int as n from after_t"))
					.rows,
			).toEqual([{ n: 1 }]);
			for (const sql of [
				"insert into after_t (x) values (2)",
				"update before_t set x = 2",
				"delete from before_t",
				"truncate before_t",
				"create table evil (x int)",
			]) {
				expect(await sqlState(reader, sql), sql).toBe("42501");
			}
		} finally {
			await reader.end();
		}
	});

	it("creates a read_write role that writes rows, including serial columns, but cannot change schema", async () => {
		expectOk(
			await neon.postgres.roles.create(
				{
					projectId,
					branchId,
					name: "e2e_writer",
					access: "read_write",
				},
				{ waitForReadiness: true },
			),
		);
		await asOwner((client) =>
			client.query("create table later_t (id serial primary key, x int)"),
		);
		const writer = await connect("e2e_writer");
		try {
			for (const sql of [
				"insert into later_t (x) values (1)",
				"insert into before_t (x) values (3)",
				"update later_t set x = 2",
				"delete from later_t",
			]) {
				expect(await sqlState(writer, sql), sql).toBe("ok");
			}
			expect(await sqlState(writer, "truncate later_t")).toBe("42501");
			expect(await sqlState(writer, "create table evil (x int)")).toBe(
				"42501",
			);
		} finally {
			await writer.end();
		}
	});

	it("rolls back on a Postgres error and leaves an existing role untouched", async () => {
		const before = expectOk(
			await neon.postgres.roles.password({
				projectId,
				branchId,
				roleName: "App-Reader",
			}),
		);
		const duplicate = await neon.postgres.roles.create(
			{ projectId, branchId, name: "App-Reader", access: "read_only" },
			{ waitForReadiness: true },
		);
		expect(duplicate.error).toBeInstanceOf(NeonApiError);
		expect(
			duplicate.error instanceof NeonApiError && duplicate.error.code,
		).toBe("42710");
		expect(duplicate.error?.message).toContain("nothing was changed");
		expect(
			expectOk(
				await neon.postgres.roles.password({
					projectId,
					branchId,
					roleName: "App-Reader",
				}),
			),
		).toBe(before);

		const missingSchema = await neon.postgres.roles.create(
			{
				projectId,
				branchId,
				name: "e2e_ghost",
				access: "read_only",
				schemas: ["no_such_schema"],
			},
			{ waitForReadiness: true },
		);
		expect(
			missingSchema.error instanceof NeonApiError &&
				missingSchema.error.code,
		).toBe("3F000");
		const roles = expectOk(
			await neon.postgres.roles.list({ projectId, branchId }),
		);
		expect(roles.map((role) => role.name)).not.toContain("e2e_ghost");
	});

	it("creates a no_login scoped role and deletes scoped roles through the API", async () => {
		const created = expectOk(
			await neon.postgres.roles.create(
				{
					projectId,
					branchId,
					name: "e2e_group",
					access: "read_only",
					no_login: true,
				},
				{ waitForReadiness: true },
			),
		);
		expect(created.password).toBeUndefined();
		expect((await attributes("e2e_group"))?.rolcanlogin).toBe(false);

		for (const roleName of ["e2e_group", "e2e_writer", "App-Reader"]) {
			expectOk(
				await neon.postgres.roles.delete(
					{ projectId, branchId, roleName },
					{ waitForReadiness: true },
				),
			);
		}
		const roles = expectOk(
			await neon.postgres.roles.list({ projectId, branchId }),
		);
		expect(roles.map((role) => role.name)).toEqual([ownerName]);
	});
});
