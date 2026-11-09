import { describe, expect, test } from "vitest";
import { toToolResult } from "./result.js";

describe("toToolResult", () => {
	test("serializes a Buffer the way JSON.stringify does", async () => {
		const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
		const { data } = await toToolResult([{ payload }]);
		expect(data).toEqual([
			{ payload: { type: "Buffer", data: [222, 173, 190, 239] } },
		]);
		expect(data).toEqual(JSON.parse(JSON.stringify([{ payload }])));
	});

	test("keeps dates as ISO strings and bigints as strings", async () => {
		const { data } = await toToolResult({
			at: new Date("2026-11-09T00:00:00.000Z"),
			size: 10n,
		});
		expect(data).toEqual({ at: "2026-11-09T00:00:00.000Z", size: "10" });
	});
});
