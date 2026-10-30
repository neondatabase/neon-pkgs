import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { neonAuthMiddleware } from "./middleware";

const config = {
	baseUrl: "https://auth.example.com",
	cookies: { secret: "test-secret-at-least-32-characters-long!" },
};

const run = (
	pathname: string,
	extra: { publicRoutes?: string[]; loginUrl?: string } = {},
) =>
	neonAuthMiddleware({ ...config, ...extra })(
		new NextRequest(`https://app.example.com${pathname}`),
	);

describe("neonAuthMiddleware publicRoutes", () => {
	test("redirects a signed-out request to a non-default route to loginUrl", async () => {
		const response = await run("/pricing", { loginUrl: "/auth/sign-in" });
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://app.example.com/auth/sign-in",
		);
	});

	test("skips exact and nested custom public routes", async () => {
		for (const pathname of ["/pricing", "/pricing/team"]) {
			const response = await run(pathname, {
				publicRoutes: ["/pricing"],
			});
			expect(response.headers.get("location")).toBeNull();
			expect(response.headers.get("x-middleware-next")).toBe("1");
		}
	});

	test("still redirects unrelated routes and does not match on a shared prefix", async () => {
		for (const pathname of ["/dashboard", "/pricing-internal"]) {
			const response = await run(pathname, {
				publicRoutes: ["/pricing"],
			});
			expect(response.headers.get("location")).toBe(
				"https://app.example.com/auth/sign-in",
			);
		}
	});

	test("keeps the default skip routes when publicRoutes is set", async () => {
		const response = await run("/auth/reset-password", {
			publicRoutes: ["/pricing"],
		});
		expect(response.headers.get("location")).toBeNull();
	});
});

describe("neonAuthMiddleware publicRoutes validation", () => {
	test.each([
		["an empty string", ""],
		["a slash-only entry", "//"],
		["an entry without a leading slash", "pricing"],
	])("rejects %s", (_name, route) => {
		expect(() =>
			neonAuthMiddleware({ ...config, publicRoutes: [route] }),
		).toThrow(/publicRoutes entries must be paths/);
	});

	test("rejects the empty entry left by a trailing comma in a split list", () => {
		const publicRoutes = "/pricing,/about,".split(",");
		expect(() => neonAuthMiddleware({ ...config, publicRoutes })).toThrow(
			/publicRoutes entries must be paths/,
		);
	});

	test("accepts valid entries, and '/' matches only the home page", async () => {
		const publicRoutes = ["/", "/pricing", "/docs/"];
		expect(() =>
			neonAuthMiddleware({ ...config, publicRoutes }),
		).not.toThrow();

		const home = await run("/", { publicRoutes });
		expect(home.headers.get("location")).toBeNull();

		for (const path of ["/docs", "/docs/intro"]) {
			const docs = await run(path, { publicRoutes });
			expect(docs.headers.get("location")).toBeNull();
		}

		const other = await run("/dashboard", { publicRoutes });
		expect(other.headers.get("location")).toBe(
			"https://app.example.com/auth/sign-in",
		);
	});
});
