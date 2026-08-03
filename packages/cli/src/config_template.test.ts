import { describe, expect, it } from "vitest";

import type { NeonConfigView } from "./config_format.js";
import {
	NEON_SERVICES,
	parseServices,
	renderNeonConfig,
	renderNeonConfigFromView,
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

describe("renderNeonConfigFromView", () => {
	it("renders a branch's live state as a policy", () => {
		const view: NeonConfigView = {
			auth: true,
			dataApi: true,
			preview: {
				buckets: { uploads: { access: "public_read" } },
				functions: { resize: { name: "Resize Image" } },
				credentials: [{ id: "credfake0000", scopes: ["storage:read"] }],
			},
			branch: {
				parent: "main",
				protected: true,
				postgres: {
					computeSettings: {
						autoscalingLimitMaxCu: 4,
						suspendTimeout: "5m",
					},
				},
			},
		};

		const { source, seeded } = renderNeonConfigFromView(view, "preview");

		expect(seeded).toBe(true);
		expect(source).toBe(`import { defineConfig } from "@neon/config/v1";

// Seeded by \`neon config init --from-branch\` from preview.
// The AI Gateway is not readable from a branch (always available, credential-gated), so add
// \`preview: { aiGateway: true }\` if the policy should declare it.
// preview is protected on Neon. Not declared here: a policy \`protected\` would
// apply to every branch this policy is applied to.
export default defineConfig({
  auth: true,
  dataApi: true,
  preview: {
    buckets: {
      uploads: { access: "public_read" },
    },
    // preview has 1 deployed function.
    // Declaring one needs the local source path, which the branch does not know:
    // functions: {
    //   resize: { name: "Resize Image", source: "./resize.ts" },
    // },
  },
  branch: () => ({
    parent: "main",
    postgres: {
      computeSettings: {
        autoscalingLimitMaxCu: 4,
        suspendTimeout: "5m",
      },
    },
  }),
});
`);
		// Issued credentials are live state, not policy — they must never be emitted.
		expect(source).not.toContain("credfake0000");
	});

	it("falls back to the starter policy for a branch with nothing to seed", () => {
		const { source, seeded } = renderNeonConfigFromView({}, "main");

		expect(seeded).toBe(false);
		expect(source).toBe(renderNeonConfig([]));
	});

	it("quotes a bucket name that isn't a valid identifier", () => {
		const { source } = renderNeonConfigFromView(
			{
				preview: {
					buckets: {
						"smoke-uploads": { access: "private" },
						assets: { access: "private" },
					},
				},
			},
			"main",
		);

		// A bare `smoke-uploads:` key is a subtraction, i.e. a syntax error.
		expect(source).toContain('"smoke-uploads": { access: "private" },');
		expect(source).toContain('assets: { access: "private" },');
	});

	it("omits the branch closure when the branch carries no tuning", () => {
		const { source } = renderNeonConfigFromView({ auth: true }, "main");

		expect(source).toContain("  auth: true,\n});");
		expect(source).not.toContain("branch:");
		expect(source).not.toContain("protected");
	});
});
