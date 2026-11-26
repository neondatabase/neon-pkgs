import { describe, expect, it } from "vitest";
import { offlinePinNext, unattendedUnauthedNext } from "./copy.js";

const saveKey = 'echo "$KEY" | neon profile create DEFAULT --api-key -';

describe("unattendedUnauthedNext", () => {
	it("offers a saved key after the sign-in steps", () => {
		expect(
			unattendedUnauthedNext(saveKey, {
				login: "neon login",
				link: "neon link --org-id org-1",
			}),
		).toEqual([
			"Link the project once the CLI is authenticated.",
			"neon login",
			"neon link --org-id org-1",
			"",
			"No browser on this machine? Create an API key in any browser at https://console.neon.tech/app/settings/api-keys, then save it instead of signing in:",
			saveKey,
		]);
	});

	it("leaves out Claimable Neon where `claim create` would refuse the directory", () => {
		expect(unattendedUnauthedNext(saveKey).join("\n")).toContain(
			"neon claim create",
		);
		expect(
			unattendedUnauthedNext(saveKey, undefined, false).join("\n"),
		).not.toContain("claim create");
	});
});

describe("offlinePinNext", () => {
	it("offers a saved key after the sign-in steps", () => {
		expect(
			offlinePinNext({
				login: "neon login",
				envPull: "neon env pull",
				saveKey,
			}),
		).toEqual([
			"The link was written without contacting Neon. Sign in to use it:",
			"neon login",
			"Then pull the branch's environment variables:",
			"neon env pull",
			"",
			"No browser on this machine? Create an API key in any browser at https://console.neon.tech/app/settings/api-keys, then save it instead of signing in:",
			saveKey,
		]);
	});
});
