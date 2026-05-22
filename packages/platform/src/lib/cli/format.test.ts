import { describe, expect, test } from "vitest";
import { defineConfig } from "../define-config.js";
import {
	formatConfigAsJson,
	formatConfigAsTypeScript,
	isPullOutputFormat,
} from "./format.js";

describe("formatConfigAsJson", () => {
	test("renders a config as pretty JSON with a trailing newline", () => {
		const out = formatConfigAsJson({ project: { name: "x" } });
		expect(out).toBe(`{\n  "project": {\n    "name": "x"\n  }\n}\n`);
	});

	test("parses back into the same shape", () => {
		const config = defineConfig({
			project: { name: "round-trip", region: "aws-us-east-1" },
			branchBlueprints: {
				production: {},
				preview: {
					pattern: "preview-*",
					ttl: "1h",
					parent: "production",
				},
			},
		});
		const out = formatConfigAsJson(config);
		expect(JSON.parse(out)).toEqual(config);
	});
});

describe("formatConfigAsTypeScript", () => {
	test("wraps the config in `import + export default defineConfig(...)`", () => {
		const out = formatConfigAsTypeScript({ project: { name: "ts" } });
		expect(out).toContain(
			'import { defineConfig } from "@neondatabase/platform/v1"',
		);
		expect(out).toContain("export default defineConfig(");
		expect(out).toContain('"name": "ts"');
		expect(out.endsWith(");\n")).toBe(true);
	});

	test("the produced source, evaluated, yields the same config", () => {
		const config = defineConfig({
			project: { name: "ts-roundtrip" },
			branchBlueprints: { production: {} },
		});
		const ts = formatConfigAsTypeScript(config);
		// Strip the import + the wrapping defineConfig(); evaluate the JSON body. This is
		// not a full TS compile, but it's enough to assert the body is valid JSON / JS.
		const bodyMatch = /export default defineConfig\(([\s\S]+)\);/.exec(ts);
		expect(bodyMatch).not.toBeNull();
		const parsed = JSON.parse(bodyMatch?.[1] ?? "");
		expect(parsed).toEqual(config);
	});
});

describe("isPullOutputFormat", () => {
	test.each([
		["ts", true],
		["json", true],
		["yaml", false],
		["", false],
		[undefined, false],
		[42, false],
		[null, false],
	])("isPullOutputFormat(%p) === %s", (input, expected) => {
		expect(isPullOutputFormat(input)).toBe(expected);
	});
});
