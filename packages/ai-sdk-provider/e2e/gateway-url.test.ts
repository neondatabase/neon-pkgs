import { describe, expect, it } from "vitest";
import { gatewayBaseUrl } from "./gateway-url.js";

describe("gatewayBaseUrl", () => {
	it("keeps the infra cell prefix the gateway routes on", () => {
		expect(
			gatewayBaseUrl(
				"br-still-river-aydd49x7",
				"ep-hidden-queen-ayzjhmb0.c-5.us-east-2.aws.neon.tech",
			),
		).toBe(
			"https://br-still-river-aydd49x7-api.ai.c-5.us-east-2.aws.neon.tech",
		);
	});

	it("drops only the endpoint label when there is no cell prefix", () => {
		expect(gatewayBaseUrl("br-a", "ep-x.us-east-2.aws.neon.tech")).toBe(
			"https://br-a-api.ai.us-east-2.aws.neon.tech",
		);
	});

	it("treats a pooler endpoint the same as a direct one", () => {
		expect(
			gatewayBaseUrl(
				"br-a",
				"ep-x-pooler.c-2.eu-central-1.aws.neon.tech",
			),
		).toBe("https://br-a-api.ai.c-2.eu-central-1.aws.neon.tech");
	});

	it("refuses a host with nothing after the endpoint label", () => {
		expect(() => gatewayBaseUrl("br-a", "localhost")).toThrow(
			/no domain left/,
		);
	});
});
