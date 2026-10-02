import { describe, expect, it } from "vitest";

import { test } from "../test_utils/fixtures";
import { authenticationLabel, userDetails } from "./user";

const user = {
	id: "u-1",
	login: "ada",
	email: "ada@example.com",
	name: "Ada",
	last_name: "Lovelace",
	image: "",
	projects_limit: 0,
	branches_limit: 0,
	max_autoscaling_limit: 0,
	active_seconds_limit: 0,
	plan: "launch",
	auth_accounts: [],
};

describe("me", () => {
	test("names the --api-key credential in the table", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["me"], { output: "table" });
	});

	test("names NEON_API_KEY in the table", async ({ testCliCommand }) => {
		const { stdout } = await testCliCommand(["me"], {
			output: "table",
			apiKey: false,
			env: { NEON_API_KEY: "env-key" },
			snapshot: false,
		});
		expect(stdout).toMatch(/^Authentication\s+API key \(NEON_API_KEY\)$/m);
		expect(stdout).not.toContain("env-key");
	});

	test("keeps JSON as the API response", async ({ testCliCommand }) => {
		await testCliCommand(["me"], { output: "json" });
	});
});

describe("userDetails", () => {
	it("joins the first and last name", () => {
		expect(userDetails(user, null).name).toBe("Ada Lovelace");
		expect(userDetails({ ...user, last_name: "" }, null).name).toBe("Ada");
	});

	it("hides a projects limit of 0 and keeps a real one", () => {
		expect(userDetails(user, null).projects_limit).toBeUndefined();
		expect(
			userDetails({ ...user, projects_limit: 20 }, null).projects_limit,
		).toBe(20);
	});

	it("omits authentication without an auth context", () => {
		expect(userDetails(user, null).authentication).toBeUndefined();
	});
});

describe("authenticationLabel", () => {
	it("names the credential the invocation used", () => {
		const base = { configDir: "/tmp/neon" };
		expect(
			authenticationLabel({
				...base,
				source: "stored-credentials",
				profile: "work",
			}),
		).toBe("OAuth (profile work)");
		expect(
			authenticationLabel({
				...base,
				source: "profile-api-key",
				profile: "dbx",
			}),
		).toBe("API key (profile dbx)");
		expect(
			authenticationLabel({
				...base,
				source: "api-key",
				apiKeyFrom: "flag",
			}),
		).toBe("API key (--api-key)");
		expect(
			authenticationLabel({
				...base,
				source: "api-key",
				apiKeyFrom: "env",
			}),
		).toBe("API key (NEON_API_KEY)");
		expect(authenticationLabel({ ...base, source: "api-key" })).toBe(
			"API key",
		);
		expect(authenticationLabel({ ...base, source: "claimable" })).toBe(
			"Claimable project",
		);
	});
});
