import "dotenv/config";

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";

import { createNeonLive } from "@neon/live/server";
import { drizzleAdapter } from "@neon/live-drizzle";
import { Pool } from "@neondatabase/serverless";
import { and, eq, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";

import type {
	CommittedTodoMutationResponse,
	CreateTodoRequest,
	TodoMutationResponse,
	UpdateTodoRequest,
} from "./api-types.js";
import { todos } from "./schema.js";

const pool = new Pool({ connectionString: required("DATABASE_URL") });
const db = drizzle(pool);
const neonLive = createNeonLive({
	secret: required("NEON_LIVE_SECRET"),
	db: required("NEON_LIVE_DATABASE"),
	adapter: drizzleAdapter(),
});

const allTodos = () =>
	db
		.select({ id: todos.id, title: todos.title, status: todos.status })
		.from(todos);

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? "/", "http://localhost");

		if (request.method === "GET" && url.pathname === "/api/todos/live") {
			const authorization = await neonLive.authorize({
				query: allTodos(),
			});
			return json(response, 200, authorization);
		}

		if (request.method === "POST" && url.pathname === "/api/todos") {
			const { title } = await body<CreateTodoRequest>(request);
			const normalizedTitle = title.trim();
			if (!normalizedTitle) {
				return json(response, 400, { error: "Title is required" });
			}
			const txid = await db.transaction(async (transaction) => {
				await transaction
					.insert(todos)
					.values({ title: normalizedTitle, status: "active" });
				const result = await transaction.execute<{ txid: string }>(
					sql`SELECT pg_current_xact_id()::text AS txid`,
				);
				return result.rows[0]?.txid;
			});
			if (!txid)
				throw new Error("PostgreSQL did not return a transaction ID");
			return json(response, 201, {
				kind: "committed",
				txid,
			} satisfies CommittedTodoMutationResponse);
		}

		const match = url.pathname.match(/^\/api\/todos\/(\d+)$/);
		if (match && request.method === "PATCH") {
			const id = Number(match[1]);
			const { status } = await body<UpdateTodoRequest>(request);
			if (status !== "active" && status !== "completed") {
				return json(response, 400, { error: "Invalid status" });
			}
			const result = await db.transaction<
				TodoMutationResponse | undefined
			>(async (transaction) => {
				const [updated] = await transaction
					.update(todos)
					.set({ status })
					.where(and(eq(todos.id, id), ne(todos.status, status)))
					.returning({ id: todos.id });
				if (updated) {
					const txidResult = await transaction.execute<{
						txid: string;
					}>(sql`SELECT pg_current_xact_id()::text AS txid`);
					const txid = txidResult.rows[0]?.txid;
					if (!txid) {
						throw new Error(
							"PostgreSQL did not return a transaction ID",
						);
					}
					return { kind: "committed", txid };
				}

				const [existing] = await transaction
					.select({ id: todos.id })
					.from(todos)
					.where(eq(todos.id, id))
					.limit(1);
				return existing ? { kind: "unchanged" } : undefined;
			});
			if (!result)
				return json(response, 404, { error: "Todo not found" });
			return json(response, 200, result);
		}

		if (match && request.method === "DELETE") {
			const id = Number(match[1]);
			const txid = await db.transaction(async (transaction) => {
				const [deleted] = await transaction
					.delete(todos)
					.where(eq(todos.id, id))
					.returning({ id: todos.id });
				if (!deleted) return undefined;
				const result = await transaction.execute<{ txid: string }>(
					sql`SELECT pg_current_xact_id()::text AS txid`,
				);
				return result.rows[0]?.txid;
			});
			if (!txid) return json(response, 404, { error: "Todo not found" });
			return json(response, 200, {
				kind: "committed",
				txid,
			} satisfies CommittedTodoMutationResponse);
		}

		json(response, 404, { error: "Not found" });
	} catch (error) {
		console.error(error);
		json(response, 500, { error: "Internal server error" });
	}
});

server.listen(3001, "127.0.0.1", () => {
	console.log("Todo API listening on http://127.0.0.1:3001");
});

async function body<T>(request: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		server.close(() => void pool.end().finally(() => process.exit()));
	});
}
