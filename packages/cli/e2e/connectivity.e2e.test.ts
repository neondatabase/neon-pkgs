import { apiRequest } from "@neon/e2e-harness";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createProject,
	deleteProject,
	runCli,
	runCliJson,
	uniqueProjectName,
	waitForProjectReady,
} from "./helpers.js";

/**
 * `connection-string` (with its `cs` alias) is the most-run command in the CLI by a wide
 * margin, and `psql` is the only command that proves the string it prints actually connects.
 * Both are checked here against one project so the suite pays for a single provisioning.
 *
 * The assertions compare against the endpoint the **API** reports rather than against another
 * CLI invocation. A string built from the wrong host is still a valid URL, and comparing two
 * CLI outputs to each other would pass happily while both were wrong.
 */
describe.sequential("e2e — neon CLI connectivity against the real API", () => {
	let projectId: string;
	let branchId: string;
	let endpointHost: string;
	let defaultRole: string;
	let defaultDatabase: string;

	/**
	 * A second role and database, created by the last test in this file rather than in setup.
	 * A branch carrying two roles makes every invocation that omits `--role-name` ambiguous
	 * and the CLI refuses it, so creating them up front would break the default-path cases.
	 * That refusal is worth pinning too, and the last test does.
	 */
	const ROLE = "e2e_alt_role";
	const DATABASE = "e2e_alt_db";

	beforeAll(async () => {
		projectId = await createProject({
			name: uniqueProjectName("cli-conn"),
		});

		const { branches } = await apiRequest<{
			branches: { id: string; default?: boolean }[];
		}>(`/projects/${projectId}/branches`);
		const branch = branches.find((candidate) => candidate.default);
		if (!branch) throw new Error("project has no default branch");
		branchId = branch.id;

		const { endpoints } = await apiRequest<{
			endpoints: { branch_id: string; type: string; host: string }[];
		}>(`/projects/${projectId}/endpoints`);
		const endpoint = endpoints.find(
			(candidate) =>
				candidate.branch_id === branch.id &&
				candidate.type === "read_write",
		);
		if (!endpoint)
			throw new Error("default branch has no read-write endpoint");
		endpointHost = endpoint.host;

		const { roles } = await apiRequest<{ roles: { name: string }[] }>(
			`/projects/${projectId}/branches/${branch.id}/roles`,
		);
		defaultRole = roles[0].name;

		const { databases } = await apiRequest<{
			databases: { name: string }[];
		}>(`/projects/${projectId}/branches/${branch.id}/databases`);
		defaultDatabase = databases[0].name;
	});

	afterAll(async () => {
		if (projectId) await deleteProject(projectId);
	});

	const connectionString = async (args: string[]): Promise<URL> => {
		const result = await runCli(
			["connection-string", "--project-id", projectId, ...args],
			{ json: false },
		);
		expect(result.code, result.stderr).toBe(0);
		return new URL(result.stdout.trim());
	};

	it("points at the endpoint the API reports, with TLS required", async () => {
		const uri = await connectionString([]);

		expect(uri.protocol).toBe("postgresql:");
		expect(uri.hostname).toBe(endpointHost);
		expect(uri.username).toBe(defaultRole);
		expect(uri.pathname).toBe(`/${defaultDatabase}`);
		expect(uri.password.length).toBeGreaterThan(0);

		const options = new URLSearchParams(uri.search);
		expect(options.get("sslmode")).toBe("require");
		expect(options.get("channel_binding")).toBe("require");
	});

	it("pools by suffixing the endpoint label and nothing else", async () => {
		const direct = await connectionString([]);
		const pooled = await connectionString(["--pooled"]);

		// The infra cell prefix and the region/cloud domain after it are load-bearing: the
		// pooler lives on the same host with `-pooler` appended to the endpoint id alone.
		const [label, ...rest] = endpointHost.split(".");
		expect(pooled.hostname).toBe([`${label}-pooler`, ...rest].join("."));

		// "and nothing else" — the rest of the connection has to be the direct one.
		expect(pooled.username).toBe(direct.username);
		expect(pooled.password).toBe(direct.password);
		expect(pooled.pathname).toBe(direct.pathname);
		expect(pooled.search).toBe(direct.search);
	});

	it("adds the Prisma pooling parameters only when pooled", async () => {
		const direct = new URLSearchParams(
			(await connectionString(["--prisma"])).search,
		);
		expect(direct.get("connect_timeout")).toBe("30");
		expect(direct.get("pgbouncer")).toBe(null);

		const pooled = new URLSearchParams(
			(await connectionString(["--prisma", "--pooled"])).search,
		);
		expect(pooled.get("connect_timeout")).toBe("30");
		expect(pooled.get("pool_timeout")).toBe("30");
		expect(pooled.get("pgbouncer")).toBe("true");
	});

	it("passes --ssl through, and omits TLS parameters entirely for omit", async () => {
		const verifyFull = new URLSearchParams(
			(await connectionString(["--ssl", "verify-full"])).search,
		);
		expect(verifyFull.get("sslmode")).toBe("verify-full");

		const omitted = new URLSearchParams(
			(await connectionString(["--ssl", "omit"])).search,
		);
		expect(omitted.get("sslmode")).toBe(null);
		expect(omitted.get("channel_binding")).toBe(null);
	});

	it("breaks the same connection into parts under --extended", async () => {
		const extended = await runCliJson<{
			connection_string: string;
			host: string;
			role: string;
			password: string;
			database: string;
			options: string;
		}>(["connection-string", "--project-id", projectId, "--extended"]);

		expect(extended.host).toBe(endpointHost);
		expect(extended.role).toBe(defaultRole);
		expect(extended.database).toBe(defaultDatabase);

		// The parts have to describe the same connection the plain command prints, or an
		// agent reading `--extended` and a human copying the one-line output end up in
		// different places. Comparing against the plain output, not against the extended
		// payload's own `connection_string`, is what makes that a real check.
		const plain = await connectionString([]);
		expect(extended.connection_string).toBe(plain.toString());
		expect(plain.hostname).toBe(extended.host);
		expect(plain.username).toBe(extended.role);
		expect(plain.password).toBe(extended.password);
		expect(plain.pathname).toBe(`/${extended.database}`);
		expect(plain.search).toBe(`?${extended.options}`);
	});

	/**
	 * `NEONCTL_PSQL_FALLBACK=1` forces the embedded TypeScript psql, so these run without a
	 * native `psql` on the machine. That is also the implementation we own: the conformance
	 * suite already proves it against vanilla Postgres in a container, and what is unproven
	 * until here is the Neon-specific half — TLS negotiation to a real endpoint, the pooler
	 * host, and the password the CLI resolved for the branch.
	 */
	const psql = (args: string[]) =>
		runCli(["psql", "--project-id", projectId, ...args], {
			json: false,
			env: { NEONCTL_PSQL_FALLBACK: "1" },
		});

	it("connects to the branch and runs a query", async () => {
		const result = await psql(["--", "-XAtc", "select 'e2e-direct-ok'"]);

		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("e2e-direct-ok");
	});

	it("connects through the pooler", async () => {
		const result = await psql([
			"--pooled",
			"--",
			"-XAtc",
			"select 'e2e-pooled-ok'",
		]);

		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("e2e-pooled-ok");
	});

	it("verifies the endpoint's certificate under --ssl verify-full", async () => {
		const result = await psql([
			"--ssl",
			"verify-full",
			"--",
			"-XAtc",
			"select 'e2e-verified-ok'",
		]);

		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("e2e-verified-ok");
	});

	it("surfaces a real Postgres rejection rather than exiting 0", async () => {
		// Passed through to psql rather than as `--database-name`, which the CLI rejects
		// before it ever connects — the point here is the server's own refusal.
		const result = await psql([
			"--",
			"-XAtc",
			"select 1",
			"-d",
			"definitely_missing_e2e_db",
		]);

		// 2 is psql's EXIT_BADCONN: the server refused the connection, which is a different
		// outcome from the CLI failing to build a connection string at all.
		expect(result.code).toBe(2);
		expect(`${result.stdout}${result.stderr}`).toMatch(
			/database "definitely_missing_e2e_db" does not exist/,
		);
	});

	/**
	 * Last, because it changes the branch: with a second role present the CLI can no longer
	 * pick one on its own. Selecting a non-default role and database is what proves the flags
	 * are read at all — passing the defaults would look identical to ignoring them.
	 */
	it("selects a non-default role and database, and refuses to guess between two", async () => {
		await apiRequest(`/projects/${projectId}/branches/${branchId}/roles`, {
			method: "POST",
			body: { role: { name: ROLE } },
		});
		// Creating the role leaves an operation in flight, and Neon answers the next
		// mutation with 423 until it settles.
		await waitForProjectReady(projectId);
		await apiRequest(
			`/projects/${projectId}/branches/${branchId}/databases`,
			{
				method: "POST",
				body: { database: { name: DATABASE, owner_name: ROLE } },
			},
		);
		await waitForProjectReady(projectId);

		const uri = await connectionString([
			"--role-name",
			ROLE,
			"--database-name",
			DATABASE,
		]);
		expect(uri.username).toBe(ROLE);
		expect(uri.pathname).toBe(`/${DATABASE}`);
		expect(uri.hostname).toBe(endpointHost);
		expect(uri.password).not.toBe("");

		const psqlAsRole = await psql([
			"--role-name",
			ROLE,
			"--database-name",
			DATABASE,
			"--",
			"-XAtc",
			"select current_user || '/' || current_database()",
		]);
		expect(psqlAsRole.code, psqlAsRole.stderr).toBe(0);
		expect(psqlAsRole.stdout.trim()).toBe(`${ROLE}/${DATABASE}`);

		const ambiguous = await runCli(
			["connection-string", "--project-id", projectId],
			{ json: false },
		);
		expect(ambiguous.code).not.toBe(0);
		expect(ambiguous.stderr).toContain("Multiple roles found");
	});
});
