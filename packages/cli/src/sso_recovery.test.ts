import { afterEach, describe, expect, it, vi } from "vitest";
import type { NeonApiError } from "./api.js";
import { recoverFromSSO } from "./sso_recovery.js";

vi.mock("open", () => ({ default: vi.fn() }));
vi.mock("./log.js", () => ({
	log: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import open from "open";
import { log } from "./log.js";

afterEach(() => {
	vi.clearAllMocks();
});

const STEP_UP_URL = "https://console.local/sso-step-up/org-1";

// The step-up URL is carried in the message; the HTTP status varies (403, or 404-masked), so
// detection is by the `code` in the body.
function ssoError(
	code: string,
	opts?: { message?: string; status?: number },
): NeonApiError {
	const message =
		opts?.message ??
		`This organization requires SSO authorization. Open ${STEP_UP_URL} in your browser to authorize, then retry.`;
	return {
		name: "NeonApiError",
		message,
		status: opts?.status ?? 403,
		statusText: "Forbidden",
		data: { code, message },
	} as NeonApiError;
}

describe("recoverFromSSO", () => {
	it("opens the step-up URL from the message and signals retry", async () => {
		vi.mocked(open).mockResolvedValue(undefined as never);

		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED"),
			true,
		);

		expect(result).toBe(true);
		expect(open).toHaveBeenCalledWith(STEP_UP_URL);
	});

	it("detects the code even when masked as 404 (existence-hiding)", async () => {
		vi.mocked(open).mockResolvedValue(undefined as never);

		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED", { status: 404 }),
			true,
		);

		expect(result).toBe(true);
		expect(open).toHaveBeenCalledWith(STEP_UP_URL);
	});

	it("treats SSO_ORG_CREDS_ONLY as terminal (no retry, no browser)", async () => {
		const result = await recoverFromSSO(
			ssoError("SSO_ORG_CREDS_ONLY"),
			true,
		);

		expect(result).toBe(false);
		expect(open).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalled();
	});

	it("does not retry when canRetry is false", async () => {
		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED"),
			false,
		);

		expect(result).toBe(false);
		expect(open).not.toHaveBeenCalled();
	});

	it("returns false when the message carries no URL", async () => {
		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED", {
				message: "SSO authorization required.",
			}),
			true,
		);

		expect(result).toBe(false);
		expect(open).not.toHaveBeenCalled();
	});

	it("prints the URL when the browser fails to open", async () => {
		vi.mocked(open).mockRejectedValue(new Error("no browser"));

		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED"),
			true,
		);

		expect(result).toBe(false);
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining("Failed to open web browser"),
		);
	});

	it("ignores non-SSO error codes", async () => {
		const result = await recoverFromSSO(ssoError("SOMETHING_ELSE"), true);

		expect(result).toBe(false);
		expect(open).not.toHaveBeenCalled();
	});
});
