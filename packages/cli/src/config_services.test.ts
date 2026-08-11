import { defineConfig } from "@neon/config-runtime";
import { describe, expect, it } from "vitest";
import { declaredNeonServices } from "./config_services.js";

describe("declaredNeonServices", () => {
	it("maps every static neon.ts service without adding Postgres", () => {
		const config = defineConfig({
			auth: true,
			dataApi: { enabled: true },
			preview: {
				buckets: {
					assets: { access: "private" },
				},
				functions: {
					api: { name: "API", source: "./api.ts" },
				},
				aiGateway: true,
			},
			branch: () => ({}),
		});

		expect(declaredNeonServices(config)).toEqual([
			"auth",
			"data-api",
			"object-storage",
			"functions",
			"ai-gateway",
		]);
	});

	it("omits explicitly disabled toggles and empty preview maps", () => {
		const config = defineConfig({
			auth: false,
			dataApi: { enabled: false },
			preview: {
				buckets: {},
				functions: {},
				aiGateway: { enabled: false },
			},
			branch: () => ({}),
		});

		expect(declaredNeonServices(config)).toEqual([]);
	});
});
