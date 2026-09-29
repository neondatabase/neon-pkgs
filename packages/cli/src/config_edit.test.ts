import { describe, expect, it } from "vitest";

import { type ConfigEdit, editNeonConfig } from "./config_edit.js";
import { CONFIG_INIT_SERVICES, renderNeonConfig } from "./config_template.js";

const fn = (slug: string): ConfigEdit => ({
	kind: "function",
	slug,
	name: "Send Email",
	source: `./functions/${slug}.ts`,
});
const service = (name: "auth" | "data-api" | "ai-gateway"): ConfigEdit => ({
	kind: "service",
	service: name,
});
const bucket = (name: string): ConfigEdit => ({
	kind: "bucket",
	name,
	access: "private",
});

const STARTER = renderNeonConfig([]);

describe("editNeonConfig on the starter policy", () => {
	it("flips auth: false to true and touches nothing else", () => {
		const result = editNeonConfig(STARTER, service("auth"));

		expect(result.changes).toEqual(["set auth: false → true"]);
		expect(result.source).toBe(
			STARTER.replace("auth: false", "auth: true"),
		);
	});

	it("puts a new service above the branch policy and its heading comment", () => {
		const { source, changes } = editNeonConfig(
			STARTER,
			service("ai-gateway"),
		);

		expect(changes).toEqual(["added aiGateway: true"]);
		expect(source).toContain(
			`  auth: false,
  aiGateway: true,
  // Branch policy: per-branch tuning
  branch: (branch) => {`,
		);
	});

	it("creates the functions block in the starter order", () => {
		const { source, changes } = editNeonConfig(STARTER, fn("sendemail"));

		expect(changes).toEqual(["added functions.sendemail"]);
		expect(source).toContain(
			`  auth: false,
  functions: {
    sendemail: { name: "Send Email", source: "./functions/sendemail.ts" },
  },
  // Branch policy: per-branch tuning`,
		);
	});

	it("creates the buckets block and quotes names that are not identifiers", () => {
		const { source } = editNeonConfig(STARTER, bucket("user-uploads"));

		expect(source).toContain(
			`  buckets: {
    "user-uploads": { access: "private" },
  },
`,
		);
	});

	it("data-api enables auth too, in that order", () => {
		const { source, changes } = editNeonConfig(
			STARTER,
			service("data-api"),
		);

		expect(changes).toEqual([
			"set auth: false → true",
			"added dataApi: true",
		]);
		expect(source).toContain(`  auth: true,
  dataApi: true,
  // Branch policy`);
	});

	it("is a no-op when run twice", () => {
		for (const edit of [
			service("auth"),
			service("data-api"),
			service("ai-gateway"),
			fn("sendemail"),
			bucket("assets"),
		]) {
			const first = editNeonConfig(STARTER, edit);
			const second = editNeonConfig(first.source, edit);
			expect(second.changes).toEqual([]);
			expect(second.source).toBe(first.source);
		}
	});
});

describe("editNeonConfig on a file that declares services already", () => {
	const FULL = renderNeonConfig(CONFIG_INIT_SERVICES);

	it("appends a function to the existing functions object", () => {
		const { source } = editNeonConfig(FULL, fn("sendemail"));

		expect(source).toContain(
			`  functions: {
    hello: { name: "Hello World", source: "./hello.ts" },
    sendemail: { name: "Send Email", source: "./functions/sendemail.ts" },
  },`,
		);
	});

	it("reports an enabled service as already declared", () => {
		expect(editNeonConfig(FULL, service("auth")).changes).toEqual([]);
		expect(editNeonConfig(FULL, service("ai-gateway")).changes).toEqual([]);
	});

	it("reports an existing function or bucket as already declared", () => {
		expect(editNeonConfig(FULL, fn("hello")).changes).toEqual([]);
		expect(editNeonConfig(FULL, bucket("assets")).changes).toEqual([]);
	});
});

describe("editNeonConfig layouts", () => {
	it("adds a comma after a last property that lacks one, keeping its trailing comment", () => {
		const source = `import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true // login
});
`;
		expect(
			editNeonConfig(source, service("ai-gateway")).source,
		).toBe(`import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true, // login
  aiGateway: true,
});
`);
	});

	it("fills an empty defineConfig({})", () => {
		const source = `export default defineConfig({});\n`;

		expect(editNeonConfig(source, service("auth")).source).toBe(
			`export default defineConfig({
  auth: true,
});\n`,
		);
	});

	it("fills an empty functions object", () => {
		const source = `export default defineConfig({
  functions: {},
});
`;
		expect(
			editNeonConfig(source, fn("a")).source,
		).toBe(`export default defineConfig({
  functions: {
    a: { name: "Send Email", source: "./functions/a.ts" },
  },
});
`);
	});

	it("keeps tabs and CRLF line endings", () => {
		const source =
			"export default defineConfig({\r\n\tauth: false,\r\n\tbranch: () => ({}),\r\n});\r\n";

		expect(editNeonConfig(source, service("ai-gateway")).source).toBe(
			"export default defineConfig({\r\n\tauth: false,\r\n\taiGateway: true,\r\n\tbranch: () => ({}),\r\n});\r\n",
		);
	});

	it("edits a plain export default object", () => {
		const source = `export default {\n  auth: false,\n};\n`;

		expect(editNeonConfig(source, service("auth")).source).toBe(
			`export default {\n  auth: true,\n};\n`,
		);
	});

	it("enables the object form of a toggle", () => {
		const source = `export default defineConfig({
  auth: { enabled: false },
});
`;
		const { source: next, changes } = editNeonConfig(
			source,
			service("auth"),
		);

		expect(changes).toEqual(["set auth.enabled: false → true"]);
		expect(next).toContain("auth: { enabled: true }");
	});

	it("does not touch an object toggle that is already on", () => {
		const source = `export default defineConfig({\n  auth: {},\n});\n`;

		expect(editNeonConfig(source, service("auth")).changes).toEqual([]);
	});

	it("data-api leaves auth alone when the provider is external", () => {
		const source = `export default defineConfig({
  dataApi: false,
});
`;
		const external = `export default defineConfig({
  dataApi: { authProvider: "external", jwksUrl: "https://idp.test/jwks" },
});
`;

		expect(editNeonConfig(source, service("data-api")).changes).toEqual([
			"added auth: true",
			"set dataApi: false → true",
		]);
		expect(editNeonConfig(external, service("data-api")).changes).toEqual(
			[],
		);
	});

	it("is not fooled by braces, commas, and comment markers inside strings, templates, and regexes", () => {
		const source = `import { defineConfig } from "@neon/config/v1";

const pattern = /[}{,]\\/\\*/g;
export default defineConfig({
  // auth: true, }
  auth: false,
  functions: {
    tricky: {
      name: "a } , { // b",
      source: \`./\${"}"}/tricky.ts\`,
    },
  },
  branch: (branch) => {
    const re = /}\\//;
    const nested = \`x\${\`y\${1}\`}// not a comment {\`;
    return branch.name.replace(re, "}") ? { ttl: "1d" } : {};
  },
});
`;
		const { source: next } = editNeonConfig(source, fn("other"));

		expect(
			next,
		).toContain(`    other: { name: "Send Email", source: "./functions/other.ts" },
  },
  branch: (branch) => {`);
		expect(editNeonConfig(next, service("auth")).source).toContain(
			"  auth: true,",
		);
	});
});

describe("editNeonConfig refusals", () => {
	it("refuses a one-line object and prints what to add", () => {
		const source = `export default defineConfig({ auth: true });\n`;

		expect(() => editNeonConfig(source, service("ai-gateway"))).toThrow(
			/one property per line[\s\S]*aiGateway: true,/,
		);
	});

	it("refuses a service declared under the deprecated preview block", () => {
		const source = `export default defineConfig({
  preview: {
    aiGateway: true,
  },
});
`;

		expect(() => editNeonConfig(source, service("ai-gateway"))).toThrow(
			/deprecated `preview` block/,
		);
	});

	it("refuses a toggle set to an expression", () => {
		const source = `export default defineConfig({
  auth: process.env.AUTH === "1",
});
`;

		expect(() => editNeonConfig(source, service("auth"))).toThrow(
			/auth is set to an expression/,
		);
	});

	it("refuses a functions value that is not an object literal", () => {
		const source = `export default defineConfig({
  functions: shared,
});
`;

		expect(() => editNeonConfig(source, fn("a"))).toThrow(
			/functions is not an object literal/,
		);
	});

	it("refuses a config that is not an object literal", () => {
		expect(() =>
			editNeonConfig(
				`export default defineConfig(base);\n`,
				service("auth"),
			),
		).toThrow(/not called with an object literal/);
		expect(() =>
			editNeonConfig(`export default 1;\n`, service("auth")),
		).toThrow(/no defineConfig/);
	});

	it("refuses source it cannot scan", () => {
		expect(() =>
			editNeonConfig(
				`export default defineConfig({ auth: "x\n`,
				service("auth"),
			),
		).toThrow(/unterminated string/);
	});
});
