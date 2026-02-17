import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectClaimUrl } from "./detect-claim-url.js";

vi.mock("@clack/prompts", () => ({
	log: {
		error: vi.fn(),
		info: vi.fn(),
		success: vi.fn(),
		step: vi.fn(),
		warning: vi.fn(),
	},
	outro: vi.fn(),
}));

describe("detectClaimUrl", () => {
	beforeEach(() => {
		vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
	});

	describe("basic cases", () => {
		it("should detect the claim URL with exact key name", () => {
			const dotEnvContent = {
				POSTGRES_CLAIM_URL: "https://pg.new/claim/123",
			};
			const dotEnvPath = ".env";
			const claimUrl = detectClaimUrl(dotEnvContent, dotEnvPath);
			expect(claimUrl).toBe("https://pg.new/claim/123");
		});

		it("should detect claim URL with different URL formats", () => {
			const dotEnvContent = {
				POSTGRES_CLAIM_URL: "https://pg.new/claim/abc-def-123?foo=bar",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env");
			expect(claimUrl).toBe("https://pg.new/claim/abc-def-123?foo=bar");
		});

		it("should work with longer URLs with multiple path segments", () => {
			const dotEnvContent = {
				POSTGRES_CLAIM_URL:
					"https://pg.new/claim/project/database/token",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env");
			expect(claimUrl).toBe(
				"https://pg.new/claim/project/database/token",
			);
		});
	});

	describe("prefixed keys", () => {
		it("should detect claim URL with single prefix", () => {
			const dotEnvContent = {
				PROD_POSTGRES_CLAIM_URL: "https://pg.new/claim/prod123",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env");
			expect(claimUrl).toBe("https://pg.new/claim/prod123");
		});

		it("should detect claim URL with multiple underscores in prefix", () => {
			const dotEnvContent = {
				DEV_STAGING_POSTGRES_CLAIM_URL:
					"https://pg.new/claim/staging456",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env.staging");
			expect(claimUrl).toBe("https://pg.new/claim/staging456");
		});

		it("should detect claim URL with lowercase prefix", () => {
			const dotEnvContent = {
				local_POSTGRES_CLAIM_URL: "https://pg.new/claim/local789",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env.local");
			expect(claimUrl).toBe("https://pg.new/claim/local789");
		});
	});

	describe("multiple keys", () => {
		it("should return first matching key when multiple keys end with POSTGRES_CLAIM_URL", () => {
			const dotEnvContent = {
				DATABASE_URL: "postgres://localhost/db",
				PROD_POSTGRES_CLAIM_URL: "https://pg.new/claim/prod",
				DEV_POSTGRES_CLAIM_URL: "https://pg.new/claim/dev",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env");
			// Should return one of the matching URLs (the first one found)
			expect(claimUrl).toMatch(/https:\/\/pg\.new\/claim\/(prod|dev)/);
		});

		it("should ignore non-matching keys", () => {
			const dotEnvContent = {
				DATABASE_URL: "postgres://localhost/db",
				OTHER_URL: "https://example.com",
				POSTGRES_CLAIM_URL: "https://pg.new/claim/correct",
				RANDOM_KEY: "random-value",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env");
			expect(claimUrl).toBe("https://pg.new/claim/correct");
		});
	});

	describe("error cases - missing key", () => {
		it("should exit when claim URL key is not found in empty object", () => {
			const dotEnvContent = {};
			const dotEnvPath = ".env";
			detectClaimUrl(dotEnvContent, dotEnvPath);
			expect(process.exit).toHaveBeenCalledWith(1);
		});

		it("should exit when claim URL key is not found with other keys present", () => {
			const dotEnvContent = {
				DATABASE_URL: "postgres://localhost/db",
				OTHER_KEY: "other-value",
			};
			detectClaimUrl(dotEnvContent, ".env");
			expect(process.exit).toHaveBeenCalledWith(1);
		});

		it("should exit when key partially matches but doesn't end correctly", () => {
			const dotEnvContent = {
				POSTGRES_CLAIM_URL_BACKUP: "https://pg.new/claim/backup",
				INSTAGRES_CLAIM: "https://pg.new/claim/wrong",
			};
			detectClaimUrl(dotEnvContent, ".env");
			expect(process.exit).toHaveBeenCalledWith(1);
		});
	});

	describe("error cases - empty value", () => {
		it("should exit when claim URL key exists but value is empty string", () => {
			const dotEnvContent = {
				POSTGRES_CLAIM_URL: "",
			};
			detectClaimUrl(dotEnvContent, ".env");
			expect(process.exit).toHaveBeenCalledWith(1);
		});

		it("should exit when prefixed claim URL key exists but value is empty", () => {
			const dotEnvContent = {
				PROD_POSTGRES_CLAIM_URL: "",
			};
			detectClaimUrl(dotEnvContent, ".env.production");
			expect(process.exit).toHaveBeenCalledWith(1);
		});
	});

	describe("edge cases - whitespace and special characters", () => {
		it("should handle URL with trailing whitespace", () => {
			const dotEnvContent = {
				POSTGRES_CLAIM_URL: "https://pg.new/claim/123 ",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env");
			expect(claimUrl).toBe("https://pg.new/claim/123 ");
		});

		it("should handle URL with leading whitespace", () => {
			const dotEnvContent = {
				POSTGRES_CLAIM_URL: " https://pg.new/claim/123",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env");
			expect(claimUrl).toBe(" https://pg.new/claim/123");
		});

		it("should handle URL with special characters", () => {
			const dotEnvContent = {
				POSTGRES_CLAIM_URL: "https://pg.new/claim/abc-123_xyz%20test",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env");
			expect(claimUrl).toBe("https://pg.new/claim/abc-123_xyz%20test");
		});
	});

	describe("different env file paths", () => {
		it("should work with .env.local path", () => {
			const dotEnvContent = {
				POSTGRES_CLAIM_URL: "https://pg.new/claim/local",
			};
			const claimUrl = detectClaimUrl(dotEnvContent, ".env.local");
			expect(claimUrl).toBe("https://pg.new/claim/local");
		});

		it("should work with custom env file path", () => {
			const dotEnvContent = {
				POSTGRES_CLAIM_URL: "https://pg.new/claim/custom",
			};
			const claimUrl = detectClaimUrl(
				dotEnvContent,
				"config/.env.production",
			);
			expect(claimUrl).toBe("https://pg.new/claim/custom");
		});
	});
});
