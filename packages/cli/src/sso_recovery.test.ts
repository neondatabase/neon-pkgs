import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NeonApiError } from "./api.js";
import { recoverFromSSO } from "./sso_recovery.js";

vi.mock("open", () => ({ default: vi.fn() }));
vi.mock("prompts", () => ({ default: vi.fn() }));
vi.mock("./env.js", () => ({ isCi: vi.fn() }));
vi.mock("./log.js", () => ({
	log: { info: vi.fn(), error: vi.fn(), warning: vi.fn(), debug: vi.fn() },
}));

import open from "open";
import prompts from "prompts";
import { isCi } from "./env.js";
import { log } from "./log.js";

const STEP_UP_URL = "https://console.local/sso-step-up/org-1";

// A fake child process: open() resolves to one, and deferred launcher failures arrive as an
// "error" event on it (never as a rejection of open() itself).
function fakeChild(): EventEmitter {
	return new EventEmitter();
}

const originalStdoutTTY = process.stdout.isTTY;
const originalStdinTTY = process.stdin.isTTY;

/** Put the process in an interactive state (a real TTY on both streams, not CI). */
function makeInteractive() {
	vi.mocked(isCi).mockReturnValue(false);
	process.stdout.isTTY = true;
	process.stdin.isTTY = true;
}

beforeEach(() => {
	// Default: interactive, browser launches cleanly, user confirms. Individual tests override.
	makeInteractive();
	vi.mocked(open).mockResolvedValue(fakeChild() as never);
	vi.mocked(prompts).mockResolvedValue({ confirmed: true });
});

afterEach(() => {
	vi.clearAllMocks();
	process.stdout.isTTY = originalStdoutTTY;
	process.stdin.isTTY = originalStdinTTY;
});

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
	it("opens the URL, waits for the user to confirm, then signals retry", async () => {
		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED"),
			true,
		);

		expect(result).toBe(true);
		expect(open).toHaveBeenCalledWith(STEP_UP_URL);
		// The retry is gated on the confirmation prompt, not on open() resolving.
		expect(prompts).toHaveBeenCalledTimes(1);
		// Order matters: the browser must launch before we wait for the user.
		expect(vi.mocked(open).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(prompts).mock.invocationCallOrder[0],
		);
	});

	it("detects the code even when masked as 404 (existence-hiding)", async () => {
		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED", { status: 404 }),
			true,
		);

		expect(result).toBe(true);
		expect(open).toHaveBeenCalledWith(STEP_UP_URL);
	});

	it("does NOT retry when the user declines the confirmation", async () => {
		vi.mocked(prompts).mockResolvedValue({ confirmed: false });

		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED"),
			true,
		);

		expect(result).toBe(false);
		expect(open).toHaveBeenCalledWith(STEP_UP_URL);
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining("was not completed"),
		);
	});

	it("does NOT retry when the prompt is cancelled (Ctrl-C → no answer)", async () => {
		vi.mocked(prompts).mockResolvedValue({}); // prompts returns {} on cancel

		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED"),
			true,
		);

		expect(result).toBe(false);
	});

	it("prints the URL and does NOT open a browser or prompt in CI", async () => {
		vi.mocked(isCi).mockReturnValue(true);

		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED"),
			true,
		);

		expect(result).toBe(false);
		expect(open).not.toHaveBeenCalled();
		expect(prompts).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining(STEP_UP_URL),
		);
	});

	it("prints the URL and does NOT open a browser or prompt without a TTY", async () => {
		vi.mocked(isCi).mockReturnValue(false);
		process.stdout.isTTY = false; // e.g. piped stdout / unattended shell

		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED"),
			true,
		);

		expect(result).toBe(false);
		expect(open).not.toHaveBeenCalled();
		expect(prompts).not.toHaveBeenCalled();
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining(STEP_UP_URL),
		);
	});

	it("still shows the URL and waits when the launcher fails in its child", async () => {
		const child = fakeChild();
		vi.mocked(open).mockResolvedValue(child as never);

		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED"),
			true,
		);
		// Deferred `spawn ENOENT`-style failure surfaces on the child after open() resolved.
		child.emit("error", new Error("spawn ENOENT"));

		// The URL was printed BEFORE launching, so the user has it regardless of the child failure,
		// and the retry is still gated on their confirmation.
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining(STEP_UP_URL),
		);
		expect(log.warning).toHaveBeenCalledWith(
			expect.stringContaining("Could not launch a browser"),
		);
		expect(result).toBe(true);
	});

	it("still shows the URL and waits when open() rejects synchronously", async () => {
		vi.mocked(open).mockRejectedValue(new Error("no browser"));

		const result = await recoverFromSSO(
			ssoError("SSO_AUTHORIZATION_REQUIRED"),
			true,
		);

		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining(STEP_UP_URL),
		);
		expect(prompts).toHaveBeenCalledTimes(1);
		expect(result).toBe(true); // user can open the printed URL manually and confirm
	});

	it("treats SSO_ORG_CREDS_ONLY as terminal (no retry, no browser)", async () => {
		const result = await recoverFromSSO(
			ssoError("SSO_ORG_CREDS_ONLY"),
			true,
		);

		expect(result).toBe(false);
		expect(open).not.toHaveBeenCalled();
		expect(prompts).not.toHaveBeenCalled();
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

	it("ignores non-SSO error codes", async () => {
		const result = await recoverFromSSO(ssoError("SOMETHING_ELSE"), true);

		expect(result).toBe(false);
		expect(open).not.toHaveBeenCalled();
	});
});
