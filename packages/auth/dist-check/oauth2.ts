// Compiled against the built declarations (`@neon/auth` resolves to
// `dist` through the package `exports`), so a type that only works from `src`
// is caught. Requires `pnpm build` first.

import { createAuthClient } from "@neon/auth";
import { createAuthServer } from "@neon/auth/server";
import { expectTypeOf } from "vitest";

const client = createAuthClient("https://auth.example.com");
expectTypeOf(client.oauth2).not.toBeAny();
expectTypeOf(client.oauth2).toHaveProperty("consent");
expectTypeOf(client.oauth2).toHaveProperty("publicClient");

const server = createAuthServer({
	baseUrl: "https://auth.example.com",
	context: () => {
		throw new Error("type-only");
	},
	cookieSecret: "x".repeat(32),
});
expectTypeOf(server.oauth2).not.toBeAny();
expectTypeOf(server.oauth2).toHaveProperty("consent");
expectTypeOf(server.oauth2).toHaveProperty("continue");
expectTypeOf(server.oauth2).toHaveProperty("publicClientPrelogin");
expectTypeOf(server.oauth2).toHaveProperty("updateConsent");
expectTypeOf(server.oauth2).toHaveProperty("deleteConsent");
expectTypeOf(server.oauth2).toHaveProperty("publicClient");
expectTypeOf(server.oauth2).toHaveProperty("getConsent");
expectTypeOf(server.oauth2).toHaveProperty("getConsents");
expectTypeOf(server.oauth2).not.toHaveProperty("token");
