import { describe, expect, it } from "vitest";

import {
	NEON_SERVICES,
	parseServices,
	renderNeonConfig,
} from "./config_template.js";

describe("parseServices", () => {
	it("accepts a comma-separated list, tolerating whitespace", () => {
		expect(parseServices("auth, functions")).toEqual(["auth", "functions"]);
	});

	it("canonicalizes order and drops duplicates", () => {
		expect(parseServices("storage,auth,storage,ai-gateway")).toEqual([
			"auth",
			"storage",
			"ai-gateway",
		]);
	});

	it('reads "none" as no services', () => {
		expect(parseServices("none")).toEqual([]);
	});

	it("rejects an unknown service by name, listing the supported values", () => {
		expect(() => parseServices("auth,data-api")).toThrow(
			/Unknown service data-api\. Supported values: auth, functions, storage, ai-gateway, none\./,
		);
	});

	it('refuses "none" alongside a real service', () => {
		expect(() => parseServices("none,auth")).toThrow(
			/cannot be combined with other services/,
		);
	});
});

describe("renderNeonConfig", () => {
	it("renders the starter policy when nothing is selected", () => {
		expect(
			renderNeonConfig([]),
		).toBe(`import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
  auth: false,
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run \`neon checkout <name>\` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
`);
	});

	it("renders every service, with the bucket's default visibility spelled out", () => {
		expect(
			renderNeonConfig(NEON_SERVICES),
		).toBe(`import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  // Declare your Neon services here
  auth: true,
  preview: {
    aiGateway: true,
    functions: {
      hello: { name: "Hello World", source: "./hello.ts" },
    },
    buckets: {
      // "private" is the default; use "public_read" for anonymous reads
      assets: { access: "private" },
    },
  },
  // Branch policy: per-branch tuning
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire
      // Run \`neon checkout <name>\` to create a new branch with these settings
      return { ttl: "7d" };
    }
    // Existing branch: no changes
    return {};
  },
});
`);
	});

	it("omits the preview block when only auth is selected", () => {
		const rendered = renderNeonConfig(["auth"]);
		expect(rendered).toContain("auth: true,");
		expect(rendered).not.toContain("preview");
	});

	it("emits a preview block with only the selected preview features", () => {
		const rendered = renderNeonConfig(["storage"]);
		expect(rendered).toContain("auth: false,");
		expect(rendered).toContain("preview: {");
		expect(rendered).toContain('assets: { access: "private" },');
		expect(rendered).not.toContain("aiGateway");
		expect(rendered).not.toContain("functions");
	});
});
