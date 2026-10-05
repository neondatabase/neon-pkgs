import { createRealtimeClient, pgTypeOids } from "@neon/realtime/client";
import { describe, expect, it } from "vitest";

import { drizzleParsers } from "./client.js";

describe("drizzleParsers", () => {
	it("is accepted by the public Realtime client API", () => {
		const client = createRealtimeClient({
			url: "ws://live.test/v1",
			parsers: drizzleParsers,
		});
		client.close();
	});

	it("keeps date as a string and interprets timestamp as UTC", () => {
		const date = drizzleParsers[pgTypeOids.date];
		const timestamp = drizzleParsers[pgTypeOids.timestamp];
		if (!date || !timestamp) throw new Error("Missing Drizzle parser");
		expect(date("2026-09-28")).toBe("2026-09-28");
		expect(timestamp("2026-09-28 13:14:15.123456")).toEqual(
			new Date("2026-09-28T13:14:15.123Z"),
		);
	});

	it("contains no Drizzle runtime import", async () => {
		const source = await import("node:fs/promises").then(({ readFile }) =>
			readFile(new URL("./client.ts", import.meta.url), "utf8"),
		);
		expect(source).not.toMatch(/from ["']drizzle-orm/);
	});
});
