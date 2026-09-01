import { describe, expect, test } from "vitest";
import { authFailureMessage } from "./auth_context.js";

describe("authFailureMessage", () => {
	test("a profile key names the profile, the file, and how to replace it", () => {
		const message = authFailureMessage({
			source: "profile-api-key",
			configDir: "/c",
			profile: "dbx",
			credentialsPath: "/c/credentials.dbx.json",
		});
		expect(message).toContain('profile "dbx"');
		expect(message).toContain("/c/credentials.dbx.json");
		// Not `rotate-key`: a rejected key cannot authenticate to mint its own replacement.
		expect(message).toContain("neon profile create dbx --mint");
		expect(message).not.toContain("--force");
		expect(message).not.toContain("rotate-key");
	});

	test("a keyring session says to sign in again and does not mention a file", () => {
		const message = authFailureMessage({
			source: "stored-credentials",
			configDir: "/c",
			profile: "work",
			storage: "keyring",
		});
		expect(message).toContain("OS keyring");
		expect(message).toContain("neon auth --profile work");
		expect(message).not.toContain("file was not created");
		expect(message).not.toContain("--api-key");
	});

	test("a keyring DEFAULT session pins --profile DEFAULT", () => {
		const message = authFailureMessage({
			source: "stored-credentials",
			configDir: "/c",
			profile: "DEFAULT",
			storage: "keyring",
		});
		expect(message).toContain("neon auth --profile DEFAULT");
	});

	test("an adopted session says to sign in again, not to check a flag", () => {
		const message = authFailureMessage({
			source: "stored-credentials",
			configDir: "/c",
			profile: "adopted",
			credentialsPath: "/elsewhere/credentials.json",
		});
		expect(message).toContain("neon auth --profile adopted");
		expect(message).not.toContain("--api-key");
	});

	test("a supplied key points at where it came from", () => {
		expect(
			authFailureMessage({ source: "api-key", configDir: "/c" }),
		).toContain("NEON_API_KEY");
	});
});
