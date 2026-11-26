import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { NeonDbError, neonConfig } from "@neondatabase/serverless";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createNeonTools } from "../../../index.js";
import { toEffectTools } from "../../effect/tools.js";
import { InspectDiagnosticError } from "./inspect/inspect.js";

const PROJECT = "proj-transport";
const BRANCH = { id: "br-main", default: true };
const DATABASE = { name: "neondb", owner_name: "neondb_owner" };

const API_ROUTES = new Map<string, unknown>([
	[`/api/v2/projects/${PROJECT}/branches`, { branches: [BRANCH] }],
	[
		`/api/v2/projects/${PROJECT}/branches/${BRANCH.id}/databases`,
		{ databases: [DATABASE] },
	],
	[
		`/api/v2/projects/${PROJECT}/branches/${BRANCH.id}/databases/neondb`,
		{ database: DATABASE },
	],
	[
		`/api/v2/projects/${PROJECT}/connection_uri`,
		{ uri: "postgresql://neondb_owner:pw@ep-test.example.test/neondb" },
	],
]);

const ONE_ROW = {
	fields: [{ name: "one", dataTypeID: 23 }],
	rows: [["1"]],
	command: "SELECT",
	rowCount: 1,
	rowAsArray: true,
};

type SqlAnswer = (
	body: string,
	req: IncomingMessage,
	res: ServerResponse,
) => void;

const dropConnection: SqlAnswer = (_body, req) => {
	req.socket.destroy();
};

let answerSql: SqlAnswer = dropConnection;
const sqlRequests: string[] = [];

const server = createServer((req, res) => {
	const path = (req.url ?? "").split("?")[0] ?? "";
	if (path === "/sql") {
		void text(req).then((body) => {
			sqlRequests.push(body);
			answerSql(body, req, res);
		});
		return;
	}
	const route = API_ROUTES.get(path);
	res.writeHead(route === undefined ? 404 : 200, {
		"content-type": "application/json",
	});
	res.end(JSON.stringify(route ?? { message: `no route for ${path}` }));
});

const defaultFetchEndpoint = neonConfig.fetchEndpoint;
let baseUrl = "";

beforeAll(async () => {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${port}/api/v2`;
	neonConfig.fetchEndpoint = `http://127.0.0.1:${port}/sql`;
});

afterAll(() => {
	neonConfig.fetchEndpoint = defaultFetchEndpoint;
	server.closeAllConnections();
	server.close();
});

const sqlTools = () =>
	createNeonTools({
		apiKey: "test-key",
		baseUrl,
		tools: ["sql.run", "sql.runTransaction", "database.inspect"] as const,
	});

const rejection = async (pending: Promise<unknown>) => {
	try {
		await pending;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to reject");
};

const TRANSPORT_MESSAGE =
	/^Network error: no response received from the database's SQL endpoint \((ECONNRESET|EPIPE|UND_ERR_SOCKET)\)\. A statement that changes data may have run anyway, so check before you retry it\.$/;

const expectTransportFailure = (error: unknown) => {
	expect(error).toBeInstanceOf(NeonDbError);
	if (!(error instanceof NeonDbError)) return;
	expect(error.code).toBeUndefined();
	expect(error.message).toMatch(TRANSPORT_MESSAGE);
	expect(error.cause).toBeInstanceOf(TypeError);
	expect(error.cause).toBe(error.sourceError);
};

describe("a SQL endpoint that drops the connection", () => {
	test("sql.run names the transport reason and keeps the fetch failure as cause", async () => {
		answerSql = dropConnection;

		const error = await rejection(
			sqlTools()["sql.run"].execute({
				project_id: PROJECT,
				sql: "select 1",
			}),
		);

		expectTransportFailure(error);
	});

	test("sql.runTransaction names the transport reason", async () => {
		answerSql = dropConnection;

		const error = await rejection(
			sqlTools()["sql.runTransaction"].execute({
				project_id: PROJECT,
				sql_statements: ["select 1", "select 2"],
			}),
		);

		expectTransportFailure(error);
	});

	test("database.inspect reports it as the connection failure, not a broken diagnostic", async () => {
		answerSql = dropConnection;

		const error = await rejection(
			sqlTools()["database.inspect"].execute({
				project_id: PROJECT,
				database_name: "neondb",
				check: "table-sizes",
			}),
		);

		expect(error).not.toBeInstanceOf(InspectDiagnosticError);
		expect(error).toBeInstanceOf(NeonDbError);
		expect(error instanceof NeonDbError && error.message).toMatch(
			/no response received from the database's SQL endpoint \((ECONNRESET|EPIPE|UND_ERR_SOCKET)\)/,
		);
	});

	test("the Effect adapter fails with NeonSqlConnectionError carrying the reason", async () => {
		answerSql = dropConnection;
		const tools = toEffectTools(sqlTools());

		const error = await Effect.runPromise(
			Effect.flip(
				tools["sql.run"].execute({
					project_id: PROJECT,
					sql: "select 1",
				}),
			),
		);

		expect(error._tag).toBe("NeonSqlConnectionError");
		expect(error.message).toMatch(TRANSPORT_MESSAGE);
	});
});

describe("answers from the SQL endpoint", () => {
	test("a read-only sql.run still composes its statement into a READ ONLY transaction", async () => {
		let readOnlyHeader: string | string[] | undefined;
		answerSql = (_body, req, res) => {
			readOnlyHeader = req.headers["neon-batch-read-only"];
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ results: [ONE_ROW] }));
		};
		sqlRequests.length = 0;

		const { data } = await sqlTools()["sql.run"].execute(
			{ project_id: PROJECT, sql: "select 1 as one" },
			{ readOnly: true },
		);

		expect(data).toMatchObject({ rows: [{ one: 1 }], totalRowCount: 1 });
		expect(sqlRequests).toEqual([
			JSON.stringify({
				queries: [{ query: "select 1 as one", params: [] }],
			}),
		]);
		expect(readOnlyHeader).toBe("true");
	});

	test("a statement Postgres rejected keeps the driver's error and SQLSTATE", async () => {
		answerSql = (_body, _req, res) => {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					message: 'column "missing_column" does not exist',
					code: "42703",
					severity: "ERROR",
				}),
			);
		};

		const error = await rejection(
			sqlTools()["sql.run"].execute({
				project_id: PROJECT,
				sql: "select missing_column",
			}),
		);

		expect(error).toBeInstanceOf(NeonDbError);
		expect(error).toMatchObject({
			message: 'column "missing_column" does not exist',
			code: "42703",
		});
	});

	test("a cancelled call keeps the driver's abort failure", async () => {
		const controller = new AbortController();
		answerSql = () => {
			controller.abort();
		};

		const error = await rejection(
			sqlTools()["sql.run"].execute(
				{ project_id: PROJECT, sql: "select pg_sleep(60)" },
				{ signal: controller.signal },
			),
		);

		expect(error).toBeInstanceOf(NeonDbError);
		expect(error instanceof NeonDbError && error.message).toMatch(
			/^Error connecting to database: AbortError/,
		);
	});
});
