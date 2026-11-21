import { describe, expect, it } from "vitest";
import { offlinePinNext, unattendedUnauthedNext } from "./copy.js";

const deferred = {
	login: "neon login",
	link: "neon link --org-id org-1",
};

describe("unattendedUnauthedNext", () => {
	it("keeps today's steps for a person", () => {
		expect(unattendedUnauthedNext(deferred)).toEqual([
			"Link the project once the CLI is authenticated.",
			"neon login",
			"neon link --org-id org-1",
		]);
		expect(unattendedUnauthedNext().join("\n")).not.toContain(
			"Do not ask the user",
		);
	});

	it("gives an agent the callback condition and the existing-key option, with or without link inputs", () => {
		for (const lines of [
			unattendedUnauthedNext(deferred, true),
			unattendedUnauthedNext(undefined, true),
		]) {
			const text = lines.join("\n");
			expect(text).toContain(
				"Sign in only if someone can complete a browser sign-in that reaches this machine's 127.0.0.1 callback:",
			);
			expect(text).toContain(
				"Otherwise set an API key the user already has as NEON_API_KEY",
			);
			expect(text).toContain("Do not ask the user to create an API key.");
		}
		expect(unattendedUnauthedNext(deferred, true).join("\n")).toContain(
			"then run `neon link --org-id org-1`",
		);
	});

	it("stores the key on the profile when --profile chose it", () => {
		const text = unattendedUnauthedNext(
			{
				login: "neon login --profile work",
				link: "neon link --org-id org-1 --profile work",
				storeKey: "neon profile create work --api-key -",
			},
			true,
		).join("\n");
		expect(text).toContain(
			"Otherwise store an API key the user already has with `neon profile create work --api-key -`, then run `neon link --org-id org-1 --profile work`.",
		);
		expect(text).not.toContain("NEON_API_KEY");
	});
});

describe("offlinePinNext", () => {
	const input = { login: "neon login", envPull: "neon env pull" };

	it("keeps today's steps for a person", () => {
		expect(offlinePinNext(input)).toEqual([
			"The link was written without contacting Neon. Sign in to use it:",
			"neon login",
			"Then pull the branch's environment variables:",
			"neon env pull",
		]);
	});

	it("gives an agent the callback condition and the existing-key option", () => {
		const text = offlinePinNext(input, true).join("\n");
		expect(text).toContain(
			"Sign in only if someone can complete a browser sign-in that reaches this machine's 127.0.0.1 callback:",
		);
		expect(text).toContain(
			"Otherwise set an API key the user already has as NEON_API_KEY, then run `neon env pull`. Do not ask the user to create an API key.",
		);
	});
});
