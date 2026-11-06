import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import {
	aiGatewayModelsUrl,
	buildAiGatewayNotice,
	fetchGatewayCatalog,
	hasFlagshipModels,
	parseGatewayCatalog,
} from "./ai_gateway_notice";

const MODELS_URL = aiGatewayModelsUrl("proj-123", "br-abc");
const BILLING_URL = "https://console.neon.tech/app/org-xyz/billing";

/** The shape `/v1/models` returns for an account with no AI Gateway credits (Free or paid). */
const NO_CREDITS_CATALOG = {
	object: "list",
	data: [
		{
			id: "claude-opus-4-8",
			enabled: false,
			unavailable_reason: "paid_plan_required",
			recovery_url: BILLING_URL,
		},
		{
			id: "gpt-5-mini",
			enabled: false,
			unavailable_reason: "paid_plan_required",
			recovery_url: BILLING_URL,
		},
	],
};

describe("hasFlagshipModels", () => {
	it("detects opus / codex / *-pro by id substring", () => {
		expect(hasFlagshipModels(["claude-opus-4-8"])).toBe(true);
		expect(hasFlagshipModels(["gpt-5-3-codex"])).toBe(true);
		expect(hasFlagshipModels(["gpt-5-5-pro"])).toBe(true);
	});

	it("is false for a catalog without any flagship model", () => {
		expect(
			hasFlagshipModels([
				"gpt-5-mini",
				"claude-haiku-4-5",
				"gemini-3-5-flash",
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

describe("parseGatewayCatalog", () => {
	it("keeps only models with enabled: true", () => {
		expect(
			parseGatewayCatalog({
				object: "list",
				data: [
					{ id: "claude-opus-4-8", enabled: false },
					{ id: "gemma-3-12b", enabled: true },
					{ id: "gpt-5-mini" },
				],
			}),
		).toEqual({ enabledIds: ["gemma-3-12b"] });
	});

	it("records the first disabled model's reason and recovery URL", () => {
		expect(parseGatewayCatalog(NO_CREDITS_CATALOG)).toEqual({
			enabledIds: [],
			unavailable: {
				reason: "paid_plan_required",
				recoveryUrl: BILLING_URL,
			},
		});
	});

	it("returns null for a non-list body", () => {
		expect(parseGatewayCatalog({ object: "model" })).toBeNull();
	});
});

describe("buildAiGatewayNotice", () => {
	it("tells an account without credits to buy them, on any plan", () => {
		const catalog = parseGatewayCatalog(NO_CREDITS_CATALOG) ?? undefined;
		const notice = buildAiGatewayNotice({
			catalog,
			moreModelsUrl: MODELS_URL,
		});
		expect(notice?.level).toBe("warning");
		expect(notice?.message).toContain("AI Gateway credits");
		expect(notice?.message).toContain("including Free");
		expect(notice?.message).toContain(BILLING_URL);
		expect(notice?.message).not.toMatch(/upgrade/i);
	});

	it("falls back to the prepaid credits docs when the gateway sends no recovery URL", () => {
		const notice = buildAiGatewayNotice({
			catalog: {
				enabledIds: [],
				unavailable: { reason: "paid_plan_required" },
			},
			moreModelsUrl: MODELS_URL,
		});
		expect(notice?.message).toContain(
			"https://neon.com/docs/ai-gateway/prepaid-credits",
		);
	});

	it("passes through any other reason with the gateway's recovery URL", () => {
		const notice = buildAiGatewayNotice({
			catalog: {
				enabledIds: [],
				unavailable: {
					reason: "account_restricted",
					recoveryUrl: "https://neon.com/docs/introduction/support",
				},
			},
			moreModelsUrl: MODELS_URL,
		});
		expect(notice?.message).toContain("(account_restricted)");
		expect(notice?.message).toContain(
			"https://neon.com/docs/introduction/support",
		);
		expect(notice?.message).not.toContain("credits");
	});

	it("stays silent for an empty catalog with no reason", () => {
		expect(
			buildAiGatewayNotice({
				catalog: { enabledIds: [] },
				moreModelsUrl: MODELS_URL,
			}),
		).toBeNull();
	});

	it("warns a reduced catalog to request more models", () => {
		const notice = buildAiGatewayNotice({
			catalog: { enabledIds: ["gpt-5-mini", "claude-haiku-4-5"] },
			moreModelsUrl: MODELS_URL,
		});
		expect(notice?.level).toBe("warning");
		expect(notice?.message).toContain(MODELS_URL);
	});

	it("stays silent for a full catalog", () => {
		expect(
			buildAiGatewayNotice({
				catalog: { enabledIds: ["gpt-5-mini", "claude-opus-4-8"] },
				moreModelsUrl: MODELS_URL,
			}),
		).toBeNull();
	});

	it("stays silent when the catalog couldn't be read", () => {
		expect(
			buildAiGatewayNotice({
				catalog: undefined,
				moreModelsUrl: MODELS_URL,
			}),
		).toBeNull();
	});

	it("never mentions the Free plan as a blocker or account verification", () => {
		const catalogs = [
			parseGatewayCatalog(NO_CREDITS_CATALOG) ?? undefined,
			{ enabledIds: ["gpt-5-mini"] },
		];
		for (const catalog of catalogs) {
			const message =
				buildAiGatewayNotice({ catalog, moreModelsUrl: MODELS_URL })
					?.message ?? "";
			expect(message).not.toMatch(/verif/i);
			expect(message).not.toMatch(/isn't available on the Free plan/i);
		}
	});
});

describe("fetchGatewayCatalog", () => {
	const serve = async (
		status: number,
		body: string,
	): Promise<{ url: string; close: () => Promise<void>; auth: string[] }> => {
		const auth: string[] = [];
		const server = createServer((req, res) => {
			auth.push(req.headers.authorization ?? "");
			res.statusCode = req.url === "/v1/models" ? status : 404;
			res.setHeader("content-type", "application/json");
			res.end(body);
		});
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const port = (server.address() as AddressInfo).port;
		return {
			url: `http://localhost:${port}/`,
			auth,
			close: () =>
				new Promise<void>((resolve) => server.close(() => resolve())),
		};
	};

	it("reads the branch's /v1/models with the pulled token", async () => {
		const server = await serve(200, JSON.stringify(NO_CREDITS_CATALOG));
		try {
			const catalog = await fetchGatewayCatalog(server.url, "tok");
			expect(catalog?.unavailable?.reason).toBe("paid_plan_required");
			expect(server.auth).toEqual(["Bearer tok"]);
		} finally {
			await server.close();
		}
	});

	it("returns null on an HTTP error rather than guessing", async () => {
		const server = await serve(500, "{}");
		try {
			expect(await fetchGatewayCatalog(server.url, "tok")).toBeNull();
		} finally {
			await server.close();
		}
	});
});
