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

	it("counts CJK Extension B as two cells", () => {
		expect(displayWidth("𠀀𠀀𠀀𠀀𠀀")).toBe(10);
	});

	it("counts wide emoji outside U+1F300 as two cells", () => {
		expect(displayWidth("🀄🀄🀄")).toBe(6);
	});

	it("counts Hangul Jamo Extended-A as two cells", () => {
		expect(displayWidth("\ua960\ua960\ua960")).toBe(6);
	});

	it("does not emit a column row wider than the TTY for Hangul Jamo Extended-A", () => {
		const out = formatHumanChunk({
			data: [{ id: "x", name: "\ua960\ua960\ua960\ua960\ua960" }],
			fields: ["id", "name"],
			width: 10,
			colorTitle: false,
		});
		for (const line of out.trimEnd().split("\n")) {
			expect(displayWidth(line)).toBeLessThanOrEqual(10);
		}
	});

	it("does not pad empty trailing cells", () => {
		const out = formatHumanChunk({
			data: [
				{ id: "301", name: "scoped", used: "" },
				{ id: "302", name: "org-wide", used: "2026-02-03T00:00:00Z" },
			],
			fields: ["id", "name", "used"],
			colorTitle: false,
		});
		for (const line of plain(out).split("\n")) {
			expect(line).toBe(line.trimEnd());
		}
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

	it("stacks two columns rather than shrinking the first", () => {
		const name = "test_branch_with_autoscaling_extra";
		const id = "br-protected-branch-123456";
		const out = formatHumanChunk({
			data: [{ name, id }],
			fields: ["name", "id"],
			width: 30,
			colorTitle: false,
		});
		expect(plain(out)).toContain(name);
		expect(plain(out)).toContain(id);
		expect(plain(out)).not.toContain("...");
		expect(plain(out).trim().split("\n")[0]).toMatch(/^Name/);
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
		expect(plain(out)).toContain("wandering-haze-25754674");
		expect(plain(out)).toContain("claimable-neon-local-state");
	});

	it("does not truncate a stacked host or password", () => {
		const host = "ep-shy-frost-a5abc123-pooler.us-east-2.aws.neon.tech";
		const out = formatHumanChunk({
			data: {
				host,
				role: "neondb_owner",
				password: "npg_1AbCdEfGhIjKlMnO",
			},
			fields: ["host", "role", "password"],
			width: 40,
			colorTitle: false,
		});
		expect(plain(out)).toContain(host);
		expect(plain(out)).toContain("npg_1AbCdEfGhIjKlMnO");
		expect(plain(out)).not.toContain("...");
	});

	it("puts a blank line before a later title", () => {
		const first = formatHumanChunk({
			data: [{ name: "images/" }],
			fields: ["name"],
			title: "folders",
			colorTitle: false,
		});
		const second = formatHumanChunk({
			data: [{ key: "hello.txt", size: "12" }],
			fields: ["key", "size"],
			title: "objects",
			colorTitle: false,
			leadingBlank: true,
		});
		expect(plain(first + second)).toBe(
			"folders\nName\nimages/\n\nobjects\nKey        Size\nhello.txt  12\n",
		);
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

	it("does not truncate a one-column list, so a URI stays copyable", () => {
		const out = formatHumanChunk({
			data: [{ value: "postgresql://very-long.example" }],
			fields: ["value"],
			width: 12,
			colorTitle: false,
		});
		expect(plain(out)).toBe("Value\npostgresql://very-long.example\n");
	});

	it("truncates the last column before dropping it", () => {
		const message =
			'ERROR: relation "orders" does not exist at character 15';
		const out = formatHumanChunk({
			data: [
				{
					timestamp: "2026-08-17T15:04:05.123Z",
					source: "postgres",
					severity: "ERROR",
					message,
				},
			],
			fields: ["timestamp", "source", "severity", "message"],
			width: 80,
			colorTitle: false,
		});
		const text = plain(out);
		expect(text).toMatch(/Message/);
		expect(text).toContain("...");
		expect(text).not.toContain(message);
		for (const line of out.trimEnd().split("\n")) {
			expect(displayWidth(line)).toBeLessThanOrEqual(80);
		}
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

	it("does not truncate a title that names a scope", () => {
		const out = formatHumanChunk({
			data: [{ id: "1" }],
			fields: ["id"],
			title: "API keys in org-7",
			width: 10,
			colorTitle: false,
		});
		expect(plain(out).split("\n")[0]).toBe("API keys in org-7");
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
