import { describe, expect, it } from "vitest";

import {
	aiGatewayModelsUrl,
	aiGatewayUpgradeUrl,
	buildAiGatewayNotice,
	freePlanBlockMessage,
	hasFlagshipModels,
	isFreePlan,
} from "./ai_gateway_notice";

const MODELS_URL = aiGatewayModelsUrl("proj-123", "br-abc");
const UPGRADE_URL = aiGatewayUpgradeUrl("org-xyz");

describe("isFreePlan", () => {
	it("treats free_v2 / free_v3 as free", () => {
		expect(isFreePlan("free_v2")).toBe(true);
		expect(isFreePlan("free_v3")).toBe(true);
	});

	it("treats paid tiers and unknowns as not free", () => {
		for (const t of [
			"launch",
			"scale",
			"business",
			"scale_v3",
			"UNKNOWN",
		]) {
			expect(isFreePlan(t)).toBe(false);
		}
		expect(isFreePlan(undefined)).toBe(false);
	});
});

describe("hasFlagshipModels", () => {
	it("detects opus / codex / *-pro by id substring", () => {
		expect(hasFlagshipModels(["claude-opus-4-8"])).toBe(true);
		expect(hasFlagshipModels(["gpt-5-3-codex"])).toBe(true);
		expect(hasFlagshipModels(["gemini-3-pro"])).toBe(true);
	});

	it("is false for a catalog without any flagship model", () => {
		expect(
			hasFlagshipModels([
				"gpt-5-mini",
				"claude-haiku-4-5",
				"gemini-2-5-flash",
			]),
		).toBe(false);
		expect(hasFlagshipModels([])).toBe(false);
	});
});

describe("aiGatewayModelsUrl", () => {
	it("builds the branch-scoped Console AI Gateway page", () => {
		expect(aiGatewayModelsUrl("proj-123", "br-abc")).toBe(
			"https://console.neon.tech/app/projects/proj-123/branches/br-abc/ai-gateway",
		);
	});
});

describe("aiGatewayUpgradeUrl", () => {
	it("is org-scoped when the project belongs to an org", () => {
		expect(aiGatewayUpgradeUrl("org-xyz")).toBe(
			"https://console.neon.tech/app/org-xyz/billing",
		);
	});

	it("falls back to the account-level billing page with no org", () => {
		expect(aiGatewayUpgradeUrl(undefined)).toBe(
			"https://console.neon.tech/app/billing",
		);
	});
});

describe("freePlanBlockMessage", () => {
	it("explains the Free-plan block without mentioning verification", () => {
		const msg = freePlanBlockMessage(UPGRADE_URL);
		expect(msg).toContain("Free plan");
		expect(msg).toContain(UPGRADE_URL);
		expect(msg).not.toMatch(/verif/i);
	});
});

describe("buildAiGatewayNotice", () => {
	it("warns Free-plan users that serving is unavailable (regardless of catalog)", () => {
		const notice = buildAiGatewayNotice({
			subscriptionType: "free_v3",
			modelIds: ["claude-opus-4-8"],
			upgradeUrl: UPGRADE_URL,
			moreModelsUrl: MODELS_URL,
		});
		expect(notice?.level).toBe("warning");
		expect(notice?.message).toContain("Free plan");
		expect(notice?.message).toContain(UPGRADE_URL);
	});

	it("warns paid users with a reduced catalog to request more models", () => {
		const notice = buildAiGatewayNotice({
			subscriptionType: "scale",
			modelIds: ["gpt-5-mini", "claude-haiku-4-5"],
			upgradeUrl: UPGRADE_URL,
			moreModelsUrl: MODELS_URL,
		});
		expect(notice?.level).toBe("warning");
		expect(notice?.message).toContain(MODELS_URL);
		expect(notice?.message).not.toContain("Free plan");
	});

	it("stays silent for a paid user with a full catalog", () => {
		expect(
			buildAiGatewayNotice({
				subscriptionType: "scale",
				modelIds: ["gpt-5-mini", "claude-opus-4-8"],
				upgradeUrl: UPGRADE_URL,
				moreModelsUrl: MODELS_URL,
			}),
		).toBeNull();
	});

	it("only offers the Free notice when the catalog wasn't probed", () => {
		expect(
			buildAiGatewayNotice({
				subscriptionType: "scale",
				modelIds: undefined,
				upgradeUrl: UPGRADE_URL,
				moreModelsUrl: MODELS_URL,
			}),
		).toBeNull();
		expect(
			buildAiGatewayNotice({
				subscriptionType: "free_v2",
				modelIds: undefined,
				upgradeUrl: UPGRADE_URL,
				moreModelsUrl: MODELS_URL,
			})?.message,
		).toContain("Free plan");
	});

	it("never mentions account verification", () => {
		for (const subscriptionType of ["free_v3", "scale"]) {
			const notice = buildAiGatewayNotice({
				subscriptionType,
				modelIds: ["gpt-5-mini"],
				upgradeUrl: UPGRADE_URL,
				moreModelsUrl: MODELS_URL,
			});
			expect(notice?.message ?? "").not.toMatch(/verif/i);
		}
	});
});
