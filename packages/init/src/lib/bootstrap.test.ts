import { describe, expect, test } from "vitest";
import { FALLBACK_TEMPLATES, parseManifest } from "./bootstrap.js";

describe("parseManifest", () => {
	test("parses a valid manifest with requires", () => {
		const yaml = `templates:
  - id: hono
    title: Hono API
    description: A Hono template.
    requires:
      - database
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
  - id: next-auth
    title: Next.js with Auth
    description: A Next.js template with auth.
    requires:
      - database
      - auth
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-next-auth
`;
		const templates = parseManifest(yaml);
		expect(templates).toHaveLength(2);
		expect(templates[0].requires).toEqual(["database"]);
		expect(templates[1].requires).toEqual(["database", "auth"]);
	});

	test("defaults requires to ['database'] when not specified", () => {
		const yaml = `templates:
  - id: hono
    title: Hono API
    description: A Hono template.
    source:
      owner: neondatabase
      repo: examples
      ref: main
      subdir: with-hono
`;
		const templates = parseManifest(yaml);
		expect(templates).toHaveLength(1);
		expect(templates[0].requires).toEqual(["database"]);
	});

	test("skips malformed entries and keeps valid ones", () => {
		const yaml = `templates:
  - id: good
    title: Good
    description: A good template.
    source:
      owner: org
      repo: repo
      ref: main
      subdir: good
  - id: bad-no-source
    title: Bad
    description: Missing source field.
  - not-even-an-object
`;
		const templates = parseManifest(yaml);
		expect(templates).toHaveLength(1);
		expect(templates[0].id).toBe("good");
	});

	test("returns empty array when all entries are malformed", () => {
		const yaml = `templates:
  - id: 123
    title: numeric id
`;
		expect(parseManifest(yaml)).toEqual([]);
	});

	test("throws when the top-level structure is invalid", () => {
		expect(() => parseManifest("not-yaml: []")).toThrow(
			'missing "templates" array',
		);
		expect(() => parseManifest("templates: not-an-array")).toThrow(
			'missing "templates" array',
		);
	});

	test("handles an empty templates array", () => {
		expect(parseManifest("templates: []")).toEqual([]);
	});
});

describe("FALLBACK_TEMPLATES", () => {
	test("contains at least one template", () => {
		expect(FALLBACK_TEMPLATES.length).toBeGreaterThan(0);
	});

	test("offers the full starter set, not just one template", () => {
		expect(FALLBACK_TEMPLATES.map((t) => t.id)).toEqual([
			"hono",
			"ai-sdk",
			"mastra",
		]);
	});

	test("each template has required fields", () => {
		for (const t of FALLBACK_TEMPLATES) {
			expect(typeof t.id).toBe("string");
			expect(typeof t.title).toBe("string");
			expect(typeof t.description).toBe("string");
			expect(Array.isArray(t.requires)).toBe(true);
			expect(t.requires.length).toBeGreaterThan(0);
			expect(typeof t.source.owner).toBe("string");
			expect(typeof t.source.repo).toBe("string");
			expect(typeof t.source.ref).toBe("string");
			expect(typeof t.source.subdir).toBe("string");
		}
	});
});
