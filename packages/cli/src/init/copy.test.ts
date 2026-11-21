import { describe, expect, it } from "vitest";
import { unattendedUnauthedNext } from "./copy.js";

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
});
