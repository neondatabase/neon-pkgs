import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies
const mockOpen = vi.fn();
const mockLog = {
	success: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	message: vi.fn(),
	step: vi.fn(),
	warning: vi.fn(),
};
const mockOutro = vi.fn();
const mockDetectClaimUrl = vi.fn();
const mockGetDotEnvContent = vi.fn();

vi.mock("open", () => ({
	default: mockOpen,
}));

vi.mock("@clack/prompts", () => ({
	log: mockLog,
	outro: mockOutro,
}));

vi.mock("./utils/detect-claim-url.js", () => ({
	detectClaimUrl: mockDetectClaimUrl,
}));

vi.mock("./utils/fs.js", () => ({
	getDotEnvContent: mockGetDotEnvContent,
}));

// Import after mocks are set up
const { claim } = await import("./claim-command.js");

describe("claim", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	});

	describe("with envPrefix", () => {
		it("should open claim URL when prefix and URL exist", async () => {
			const dotEnvPath = ".env";
			const envPrefix = "MY_PREFIX_";
			const claimUrl = "https://pg.new/claim/abc123";

			mockGetDotEnvContent.mockReturnValue({
				MY_PREFIX_POSTGRES_CLAIM_URL: claimUrl,
			});
			mockOpen.mockResolvedValue(undefined);

			await claim(dotEnvPath, envPrefix);

			expect(mockGetDotEnvContent).toHaveBeenCalledWith(dotEnvPath);
			expect(mockLog.success).toHaveBeenCalledWith(
				"URL located. Opening your default browser.",
			);
			expect(mockOpen).toHaveBeenCalledWith(claimUrl);
			expect(mockOutro).toHaveBeenCalledWith(
				`You can also manually open: ${claimUrl}.`,
			);
			expect(process.exit).toHaveBeenCalledWith(0);
		});

		it("should exit with error when prefixed claim URL not found", async () => {
			const dotEnvPath = ".env";
			const envPrefix = "MY_PREFIX_";

			mockGetDotEnvContent.mockReturnValue({
				SOME_OTHER_KEY: "value",
			});

			await claim(dotEnvPath, envPrefix);

			expect(mockGetDotEnvContent).toHaveBeenCalledWith(dotEnvPath);
			expect(mockLog.error).toHaveBeenCalledWith(
				`MY_PREFIX_POSTGRES_CLAIM_URL not found in ${dotEnvPath}.`,
			);
			expect(mockOutro).toHaveBeenCalledWith(
				"Use `get-db claim -p <prefix>` to override URL auto-detection.",
			);
			expect(mockOpen).not.toHaveBeenCalled();
			expect(process.exit).toHaveBeenCalledWith(1);
		});

		it("should handle empty string claim URL", async () => {
			const dotEnvPath = ".env";
			const envPrefix = "MY_PREFIX_";

			mockGetDotEnvContent.mockReturnValue({
				MY_PREFIX_POSTGRES_CLAIM_URL: "",
			});

			await claim(dotEnvPath, envPrefix);

			expect(mockLog.error).toHaveBeenCalledWith(
				`MY_PREFIX_POSTGRES_CLAIM_URL not found in ${dotEnvPath}.`,
			);
			expect(mockOpen).not.toHaveBeenCalled();
			expect(process.exit).toHaveBeenCalledWith(1);
		});
	});

	describe("without envPrefix (auto-detection)", () => {
		it("should detect and open claim URL successfully", async () => {
			const dotEnvPath = ".env";
			const claimUrl = "https://pg.new/claim/xyz789";

			mockGetDotEnvContent.mockReturnValue({
				PUBLIC_POSTGRES_CLAIM_URL: claimUrl,
			});
			mockDetectClaimUrl.mockReturnValue(claimUrl);
			mockOpen.mockResolvedValue(undefined);

			await claim(dotEnvPath);

			expect(mockGetDotEnvContent).toHaveBeenCalledWith(dotEnvPath);
			expect(mockDetectClaimUrl).toHaveBeenCalledWith(
				{ PUBLIC_POSTGRES_CLAIM_URL: claimUrl },
				dotEnvPath,
			);
			expect(mockLog.success).toHaveBeenCalledWith(
				"URL located. Opening your default browser.",
			);
			expect(mockOpen).toHaveBeenCalledWith(claimUrl);
			expect(mockOutro).toHaveBeenCalledWith(
				`You can also manually open: ${claimUrl}.`,
			);
			expect(process.exit).toHaveBeenCalledWith(0);
		});

		it("should handle detectClaimUrl calling process.exit", async () => {
			const dotEnvPath = ".env";

			mockGetDotEnvContent.mockReturnValue({});
			// detectClaimUrl will call process.exit(1) which is mocked
			// We need to mock open to prevent it from being called after process.exit
			mockOpen.mockResolvedValue(undefined);
			mockDetectClaimUrl.mockImplementation(() => {
				process.exit(1);
				// Return empty string to prevent undefined being passed to openClaimUrl
				return "";
			});

			await claim(dotEnvPath);

			expect(mockDetectClaimUrl).toHaveBeenCalled();
			expect(process.exit).toHaveBeenCalledWith(1);
		});
	});

	describe("openClaimUrl error handling", () => {
		it("should handle open() failure with Error object", async () => {
			const dotEnvPath = ".env";
			const claimUrl = "https://pg.new/claim/abc123";
			const errorMessage = "Failed to open browser";

			mockGetDotEnvContent.mockReturnValue({
				PUBLIC_POSTGRES_CLAIM_URL: claimUrl,
			});
			mockDetectClaimUrl.mockReturnValue(claimUrl);
			mockOpen.mockRejectedValue(new Error(errorMessage));

			await claim(dotEnvPath);

			expect(mockLog.success).toHaveBeenCalledWith(
				"URL located. Opening your default browser.",
			);
			expect(mockOpen).toHaveBeenCalledWith(claimUrl);
			expect(mockLog.error).toHaveBeenCalledWith(errorMessage);
			expect(process.exit).toHaveBeenCalledWith(1);
		});

		it("should handle open() failure with non-Error object", async () => {
			const dotEnvPath = ".env";
			const claimUrl = "https://pg.new/claim/abc123";

			mockGetDotEnvContent.mockReturnValue({
				PUBLIC_POSTGRES_CLAIM_URL: claimUrl,
			});
			mockDetectClaimUrl.mockReturnValue(claimUrl);
			mockOpen.mockRejectedValue("some error");

			await claim(dotEnvPath);

			expect(mockLog.error).toHaveBeenCalledWith(
				"Failed to open claim URL",
			);
			expect(process.exit).toHaveBeenCalledWith(1);
		});
	});

	describe("edge cases", () => {
		it("should handle different prefix formats", async () => {
			const dotEnvPath = ".env.local";
			const envPrefix = "VITE_";
			const claimUrl = "https://pg.new/claim/test";

			mockGetDotEnvContent.mockReturnValue({
				VITE_POSTGRES_CLAIM_URL: claimUrl,
			});
			mockOpen.mockResolvedValue(undefined);

			await claim(dotEnvPath, envPrefix);

			expect(mockOpen).toHaveBeenCalledWith(claimUrl);
			expect(process.exit).toHaveBeenCalledWith(0);
		});

		it("should work with custom dotEnvPath", async () => {
			const dotEnvPath = ".env.production";
			const claimUrl = "https://pg.new/claim/prod";

			mockGetDotEnvContent.mockReturnValue({
				POSTGRES_CLAIM_URL: claimUrl,
			});
			mockDetectClaimUrl.mockReturnValue(claimUrl);
			mockOpen.mockResolvedValue(undefined);

			await claim(dotEnvPath);

			expect(mockGetDotEnvContent).toHaveBeenCalledWith(dotEnvPath);
			expect(mockDetectClaimUrl).toHaveBeenCalledWith(
				{ POSTGRES_CLAIM_URL: claimUrl },
				dotEnvPath,
			);
			expect(process.exit).toHaveBeenCalledWith(0);
		});
	});
});
