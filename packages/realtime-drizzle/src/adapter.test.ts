import { createRealtime, type SealedLiveQuery } from "@neon/realtime/server";
import { and, eq, gte, sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	char,
	cidr,
	customType,
	date,
	doublePrecision,
	inet,
	integer,
	interval,
	json,
	jsonb,
	line,
	macaddr,
	macaddr8,
	numeric,
	pgEnum,
	pgTable,
	point,
	real,
	serial,
	smallint,
	text,
	time,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { drizzleAdapter } from "./index.js";

const channels = pgTable("adapter_channels", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
});

const messages = pgTable("adapter_messages", {
	id: serial("id").primaryKey(),
	channelId: text("channel_id").notNull(),
	authorId: text("author_id").notNull(),
	body: text("body").notNull(),
	sequence: integer("sequence").notNull(),
	note: text("note"),
	published: boolean("published").notNull(),
});

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
	dataType: () => "bytea",
	toDriver: (value) => value,
});

const priority = pgEnum("adapter_priority", ["low", "high"]);

const parameterTypes = pgTable("adapter_parameter_types", {
	id: serial("id").primaryKey(),
	boolValue: boolean("bool_value").notNull(),
	int2Value: smallint("int2_value").notNull(),
	int8Value: bigint("int8_value", { mode: "bigint" }).notNull(),
	float4Value: real("float4_value").notNull(),
	float8Value: doublePrecision("float8_value").notNull(),
	numericValue: numeric("numeric_value", {
		precision: 12,
		scale: 3,
	}).notNull(),
	varcharValue: varchar("varchar_value", { length: 64 }).notNull(),
	charValue: char("char_value", { length: 3 }).notNull(),
	uuidValue: uuid("uuid_value").notNull(),
	dateValue: date("date_value", { mode: "date" }).notNull(),
	timestampValue: timestamp("timestamp_value").notNull(),
	timestamptzValue: timestamp("timestamptz_value", {
		withTimezone: true,
	}).notNull(),
	timeValue: time("time_value").notNull(),
	timetzValue: time("timetz_value", { withTimezone: true }).notNull(),
	intervalValue: interval("interval_value").notNull(),
	jsonValue: json("json_value").notNull(),
	jsonbValue: jsonb("jsonb_value").notNull(),
	inetValue: inet("inet_value").notNull(),
	cidrValue: cidr("cidr_value").notNull(),
	macaddrValue: macaddr("macaddr_value").notNull(),
	macaddr8Value: macaddr8("macaddr8_value").notNull(),
	pointValue: point("point_value").notNull(),
	lineValue: line("line_value").notNull(),
	int4ArrayValue: integer("int4_array_value").array().notNull(),
	byteaValue: bytea("bytea_value").notNull(),
	priorityValue: priority("priority_value").notNull(),
});

const db = drizzle(async () => ({ rows: [] }));
const SECRET =
	"neon_live_v1_eyJ2IjoxLCJraWQiOiJjdXJyZW50IiwiaXNzIjoidGVzdCIsImtleSI6IkJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2NIQndjSEJ3Y0hCd2MifQ";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("concrete Drizzle query adapter", () => {
	it("uses Drizzle's SQL and driver-ready values with OID zero", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const realtime = createRealtime({
			secret: SECRET,
			db: "app",
			adapter: drizzleAdapter(),
		});
		const channelId = "general";
		const viewerId = "user-7";
		const minimumSequence = 3;
		const query = db
			.select({
				messageId: sql<number>`${messages.id}`.as("messageId"),
				channelId: sql<string>`${messages.channelId}`.as("channelId"),
				body: messages.body,
				note: messages.note,
			})
			.from(messages)
			.where(
				and(
					eq(messages.channelId, channelId),
					eq(messages.authorId, viewerId),
					gte(messages.sequence, minimumSequence),
				),
			);

		const sealedQuery = await realtime.seal({ query });

		expectTypeOf(sealedQuery).toEqualTypeOf<
			SealedLiveQuery<{
				messageId: number;
				channelId: string;
				body: string;
				note: string | null;
			}>
		>();
		expect(JSON.stringify(sealedQuery)).not.toContain(channelId);
		expect(JSON.stringify(sealedQuery)).not.toContain(viewerId);

		expect(fetch).not.toHaveBeenCalled();

		const prepared = drizzleAdapter().prepare(query);
		expect(prepared.sql).toContain("$1");
		expect(prepared.sql).toContain("$2");
		expect(prepared.sql).toContain("$3");
		expect(prepared.sql).not.toContain(channelId);
		expect(prepared.sql).not.toContain(viewerId);
		expect(prepared.parameters.map(decodeParameter)).toEqual([
			channelId,
			viewerId,
			String(minimumSequence),
		]);
		expect(prepared.parameters.map(({ typeOid }) => typeOid)).toEqual([
			0, 0, 0,
		]);
	});

	it("fingerprints the separately bound values", async () => {
		const realtime = createRealtime({
			secret: SECRET,
			db: "app",
			adapter: drizzleAdapter(),
		});
		const query = (channelId: string) =>
			db
				.select({ id: messages.id })
				.from(messages)
				.where(eq(messages.channelId, channelId));

		const first = await realtime.seal({ query: query("general") });
		const repeated = await realtime.seal({ query: query("general") });
		const changed = await realtime.seal({ query: query("random") });

		expect(first.queryFingerprint).toBe(repeated.queryFingerprint);
		expect(first.queryFingerprint).not.toBe(changed.queryFingerprint);
	});

	it("supports Drizzle's built-in PostgreSQL parameter encoders", () => {
		const instant = new Date("2026-09-11T12:34:56.789Z");
		const bytes = Uint8Array.of(0, 1, 127, 255);
		const query = db
			.select({ id: parameterTypes.id })
			.from(parameterTypes)
			.where(
				and(
					eq(parameterTypes.boolValue, true),
					eq(parameterTypes.int2Value, 12),
					eq(parameterTypes.int8Value, 9_007_199_254_740_993n),
					eq(parameterTypes.float4Value, 1.25),
					eq(parameterTypes.float8Value, 2.5),
					eq(parameterTypes.numericValue, "123456.789"),
					eq(parameterTypes.varcharValue, "varchar"),
					eq(parameterTypes.charValue, "abc"),
					eq(
						parameterTypes.uuidValue,
						"123e4567-e89b-12d3-a456-426614174000",
					),
					eq(parameterTypes.dateValue, instant),
					eq(parameterTypes.timestampValue, instant),
					eq(parameterTypes.timestamptzValue, instant),
					eq(parameterTypes.timeValue, "12:34:56"),
					eq(parameterTypes.timetzValue, "12:34:56+02"),
					eq(parameterTypes.intervalValue, "1 day 02:03:04"),
					eq(parameterTypes.jsonValue, { enabled: true }),
					eq(parameterTypes.jsonbValue, { nested: [1, 2] }),
					eq(parameterTypes.inetValue, "192.0.2.1"),
					eq(parameterTypes.cidrValue, "192.0.2.0/24"),
					eq(parameterTypes.macaddrValue, "08:00:2b:01:02:03"),
					eq(parameterTypes.macaddr8Value, "08:00:2b:ff:fe:01:02:03"),
					eq(parameterTypes.pointValue, [1.5, 2.5]),
					eq(parameterTypes.lineValue, [1, 2, 3]),
					eq(parameterTypes.int4ArrayValue, [1, 2, 3]),
					eq(parameterTypes.byteaValue, bytes),
				),
			);

		const prepared = drizzleAdapter().prepare(query);

		expect(prepared.parameters.every(({ typeOid }) => typeOid === 0)).toBe(
			true,
		);
		const decoded = prepared.parameters.map(decodeParameter);
		expect(decoded[0]).toBe("true");
		expect(decoded[9]).toContain("2026-09-11");
		expect(decoded[15]).toBe('{"enabled":true}');
		expect(decoded[23]).toBe("{1,2,3}");
		expect(decoded[24]).toBe("\\x00017fff");
	});

	it("also uses OID zero for database-specific parameter types", () => {
		const query = db
			.select({ id: parameterTypes.id })
			.from(parameterTypes)
			.where(eq(parameterTypes.priorityValue, "high"));

		const prepared = drizzleAdapter().prepare(query);
		expect(prepared.parameters.map(decodeParameter)).toEqual(["high"]);
		expect(prepared.parameters.map(({ typeOid }) => typeOid)).toEqual([0]);
	});

	it("does not need result metadata for outer joins", () => {
		const query = db
			.select({
				id: messages.id,
				name: channels.name,
			})
			.from(messages)
			.leftJoin(channels, eq(messages.channelId, channels.id));

		expect(drizzleAdapter().prepare(query)).toMatchObject({
			parameters: [],
		});
	});

	it("uses OID zero when Drizzle has no parameter type metadata", () => {
		const query = db
			.select({ id: messages.id })
			.from(messages)
			.where(sql`${messages.channelId} = ${"general"}`);

		const prepared = drizzleAdapter().prepare(query);
		expect(prepared.parameters.map(decodeParameter)).toEqual(["general"]);
		expect(prepared.parameters.map(({ typeOid }) => typeOid)).toEqual([0]);
	});

	it("accepts parameters safely inlined by Drizzle", () => {
		const condition = eq(messages.channelId, "general").inlineParams();
		const query = db
			.select({ id: messages.id })
			.from(messages)
			.where(condition);

		expect(drizzleAdapter().prepare(query)).toMatchObject({
			parameters: [],
		});
	});

	it("defers result types to the subscription schema", () => {
		const query = db
			.select({ published: messages.published })
			.from(messages);

		expect(() => drizzleAdapter().prepare(query)).not.toThrow();
	});

	it("accepts explicitly aliased computed selections", () => {
		const query = db
			.select({
				upperBody: sql<string>`upper(${messages.body})`.as("upperBody"),
			})
			.from(messages);

		expect(() => drizzleAdapter().prepare(query)).not.toThrow();
	});
});

function decodeParameter(parameter: { readonly value: string | null }) {
	return parameter.value;
}
