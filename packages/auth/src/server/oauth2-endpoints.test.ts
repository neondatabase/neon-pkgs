import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { describe, expect, test } from "vitest";
import { OAUTH2_ENDPOINTS } from "../core/better-auth-methods";

const auth = betterAuth({
	baseURL: "http://localhost",
	secret: "test-secret-at-least-32-characters-long!",
	database: memoryAdapter({}),
	plugins: [
		jwt(),
		oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" }),
	],
});

const routes = new Map<string, Set<string>>();
for (const route of Object.values(
	auth.api as unknown as Record<string, unknown>,
)) {
	const { path, options } = route as {
		path?: unknown;
		options?: { method?: string | string[] };
	};
	if (typeof path !== "string" || !path.startsWith("/oauth2/")) continue;
	const methods = [options?.method ?? []].flat();
	const known = routes.get(path) ?? new Set<string>();
	for (const m of methods) known.add(m.toUpperCase());
	routes.set(path, known);
}

describe("OAUTH2_ENDPOINTS matches the oauthProvider plugin routes", () => {
	test("lists exactly the plugin /oauth2/ routes", () => {
		const pluginNames = [...routes.keys()]
			.map((path) => path.slice("/oauth2/".length))
			.toSorted();
		expect(pluginNames.filter((n) => n.includes(":"))).toEqual([]);
		expect(OAUTH2_ENDPOINTS.toSorted()).toEqual(pluginNames);
	});
});
