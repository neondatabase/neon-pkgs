import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import {
	displayWidth,
	formatHumanChunk,
	parseColumns,
	resolveOutputWidth,
} from "./human_table.js";

const plain = (s: string) => stripAnsi(s);

const BOX = /[┌┐└┘├┤┬┴┼─│]/;

describe("resolveOutputWidth", () => {
	it("uses a positive override first", () => {
		const out = Object.assign(new PassThrough(), { columns: 40 });
		expect(resolveOutputWidth(out, 80, { stdout: process.stdout })).toBe(
			80,
		);
	});

	it("floors a fractional override", () => {
		expect(resolveOutputWidth(new PassThrough(), 40.9)).toBe(40);
	});

	it("treats null as unknown even when the stream has columns", () => {
		const out = Object.assign(new PassThrough(), { columns: 40 });
		expect(resolveOutputWidth(out, null)).toBeUndefined();
	});

	it("reads columns from the stream it writes to", () => {
		const out = Object.assign(new PassThrough(), { columns: 40 });
		expect(resolveOutputWidth(out, undefined)).toBe(40);
	});

	it("does not inherit process.stdout.columns for another stream", () => {
		const out = new PassThrough();
		expect(
			resolveOutputWidth(out, undefined, {
				stdout: Object.assign(new PassThrough(), { columns: 120 }),
				envColumns: "40",
			}),
		).toBeUndefined();
	});

	it("reads COLUMNS only when writing to stdout", () => {
		const stdout = new PassThrough();
		expect(
			resolveOutputWidth(stdout, undefined, {
				stdout,
				envColumns: "40",
			}),
		).toBe(40);
	});

	it("ignores a non-positive stream width and a bad COLUMNS value", () => {
		const stdout = Object.assign(new PassThrough(), { columns: 0 });
		expect(
			resolveOutputWidth(stdout, undefined, {
				stdout,
				envColumns: "nope",
			}),
		).toBeUndefined();
	});
});

describe("parseColumns", () => {
	it("accepts a positive integer string", () => {
		expect(parseColumns("80")).toBe(80);
	});

	it("rejects empty, zero, negative, and non-digits", () => {
		expect(parseColumns(undefined)).toBeUndefined();
		expect(parseColumns("")).toBeUndefined();
		expect(parseColumns("0")).toBeUndefined();
		expect(parseColumns("-2")).toBeUndefined();
		expect(parseColumns("80.5")).toBeUndefined();
		expect(parseColumns(" 80")).toBeUndefined();
	});
});

describe("displayWidth", () => {
	it("ignores ANSI color sequences", () => {
		expect(displayWidth("\u001b[32mFoo\u001b[39m")).toBe(3);
	});

	it("counts CJK as two cells", () => {
		expect(displayWidth("東京")).toBe(4);
	});
});

describe("formatHumanChunk", () => {
	it("stacks a single object", () => {
		const out = formatHumanChunk({
			data: { foo: "bar", extra: "skip" },
			fields: ["foo"],
			colorTitle: false,
		});
		expect(plain(out)).toBe("Foo  bar\n");
		expect(out).not.toMatch(BOX);
	});

	it("prints a list as columns when width is unknown", () => {
		const out = formatHumanChunk({
			data: [
				{ id: "a", name: "alpha" },
				{ id: "b", name: "beta" },
			],
			fields: ["id", "name"],
			title: "Items",
			colorTitle: false,
		});
		expect(plain(out)).toBe("Items\nId  Name\na   alpha\nb   beta\n");
		expect(out).not.toMatch(BOX);
	});

	it("drops trailing columns so a list fits", () => {
		const out = formatHumanChunk({
			data: [
				{
					id: "p1",
					name: "demo",
					region: "us-east",
					created: "2026-08-11T16:42:59Z",
				},
			],
			fields: ["id", "name", "region", "created"],
			width: 17,
			colorTitle: false,
		});
		expect(out).not.toMatch(BOX);
		for (const line of out.trimEnd().split("\n")) {
			expect(displayWidth(line)).toBeLessThanOrEqual(17);
		}
		expect(plain(out)).toMatch(/Id/);
		expect(plain(out)).toMatch(/Name/);
		expect(plain(out)).toMatch(/Region/);
		expect(plain(out)).not.toContain("2026-08-11T16:42:59Z");
		expect(plain(out)).not.toMatch(/Created/);
	});

	it("drops trailing columns before shrinking remaining cells to ...", () => {
		const out = formatHumanChunk({
			data: [
				{
					id: "wandering-haze-25754674",
					name: "claimable-neon-local-state",
					region: "aws-us-east-2",
					created: "2026-08-11T16:42:59Z",
				},
			],
			fields: ["id", "name", "region", "created"],
			width: 40,
			colorTitle: false,
		});
		const text = plain(out);
		expect(text).not.toMatch(/Region|Created|aws-us-east-2|2026-08-11/);
		expect(text).toMatch(/Id/);
		expect(text).toMatch(/Name/);
		expect(
			text
				.split("\n")
				.some((line) => /^\S+\s+\.\.\.\s+\.\.\./.test(line)),
		).toBe(false);
		for (const line of out.trimEnd().split("\n")) {
			expect(displayWidth(line)).toBeLessThanOrEqual(40);
		}
	});

	it("truncates a cell that still overflows after dropping", () => {
		const out = formatHumanChunk({
			data: [
				{
					id: "wandering-haze-25754674",
					name: "claimable-neon-local-state",
				},
			],
			fields: ["id", "name"],
			width: 30,
			colorTitle: false,
		});
		expect(out).toContain("...");
		for (const line of out.trimEnd().split("\n")) {
			expect(displayWidth(line)).toBeLessThanOrEqual(30);
		}
	});

	it("stacks a list and restores every field when two columns will not fit", () => {
		const out = formatHumanChunk({
			data: [
				{
					id: "wandering-haze-25754674",
					name: "claimable-neon-local-state",
				},
			],
			fields: ["id", "name"],
			width: 7,
			colorTitle: false,
		});
		const lines = plain(out).trim().split("\n");
		expect(lines[0]).toMatch(/^Id/);
		expect(lines.length).toBe(2);
		expect(lines[1]).not.toMatch(/^Id/);
		for (const line of out.trimEnd().split("\n")) {
			expect(displayWidth(line)).toBeLessThanOrEqual(7);
		}
	});

	it("prints a one-column list without stacking", () => {
		const out = formatHumanChunk({
			data: [{ value: "api" }, { value: "postgres" }],
			fields: ["value"],
			title: "values",
			colorTitle: false,
		});
		expect(plain(out)).toBe("values\nValue\napi\npostgres\n");
	});

	it("truncates a one-column list to the width", () => {
		const out = formatHumanChunk({
			data: [{ value: "postgresql://very-long.example" }],
			fields: ["value"],
			width: 12,
			colorTitle: false,
		});
		expect(plain(out)).toBe("Value\npostgresq...\n");
	});

	it("flattens arrays, objects, and newlines, including renderColumns", () => {
		const out = formatHumanChunk({
			data: [
				{
					id: "1",
					tags: ["a", "b"],
					meta: { k: 1 },
					note: "line1\nline2",
				},
			],
			fields: ["id", "tags", "meta", "note"],
			renderColumns: {
				note: (item: unknown) => {
					if (
						item !== null &&
						typeof item === "object" &&
						"note" in item
					) {
						return String(Reflect.get(item, "note"));
					}
					return "";
				},
			},
			colorTitle: false,
		});
		expect(out).toContain("a, b");
		expect(out).toContain('{"k":1}');
		expect(out).toContain("line1 line2");
		expect(out).not.toMatch(/\nline2/);
	});

	it("writes emptyMessage without a title, matching the previous writer", () => {
		const out = formatHumanChunk({
			data: [],
			fields: ["id"],
			title: "Projects",
			emptyMessage: "You don't have any projects yet.",
			colorTitle: false,
		});
		expect(out).toBe("\nYou don't have any projects yet.\n");
	});

	it("does not put a box around a custom renderer", () => {
		const out = formatHumanChunk({
			data: { foo: "bar" },
			fields: ["foo"],
			title: "T1",
			renderColumns: {
				foo: () => "Here is: bar",
			},
			colorTitle: false,
		});
		expect(plain(out)).toBe("T1\nFoo  Here is: bar\n");
	});
});
