import { NeonAuthError } from "@neon/sdk";
import { describe, expect, test } from "vitest";
import { createNeonTools } from "./index.js";

const fullStatus = {
	spending_limit_cents: 10000,
	spend_cap_enabled: true,
	current_usage_cents: 10042,
	usage_observed_at: "2026-11-25T09:00:00Z",
	invoice_period_id: "current-open-invoice",
	status: "reached",
	enforcement_status: "pending",
	generation: 14,
	period_ends_at: "2026-12-01T00:00:00Z",
	monitoring_delay: "1-2 hours",
	warning: "Observed usage has reached the cap; suspension is being applied.",
};

const additiveStatus = {
	...fullStatus,
	status: "new_server_state",
	enforcement_status: "awaiting_target",
};

const setup = (response: object = fullStatus, status = 200) => {
	const requests: Request[] = [];
	const tools = createNeonTools({
		apiKey: "test-key",
		baseUrl: "https://example.test/api/v2",
		tools: [
			"organizations.spendingLimit.get",
			"organizations.spendingLimit.set",
			"organizations.spendingLimit.disable",
		],
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(JSON.stringify(response), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { requests, tools };
};

describe("organization spend caps", () => {
	test("uses the authenticated SDK transport and preserves every status field", async () => {
		const { tools, requests } = setup();
		const { data } = await tools["organizations.spendingLimit.get"].execute(
			{ org_id: "org-1" },
		);
		expect(data).toMatchObject(fullStatus);
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(
			"https://example.test/api/v2/organizations/org-1/billing/spending_limit",
		);
		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer test-key",
		);
		expect(data.notice).toContain("Storage charges continue");
		expect(data.notice).toContain("first UTC calendar day");
	});

	test("does not invent status for a legacy notification-only response", async () => {
		const { tools } = setup({ spending_limit_cents: 10000 });
		const { data } = await tools["organizations.spendingLimit.get"].execute(
			{ org_id: "org-1" },
		);
		expect(data).not.toHaveProperty("spend_cap_enabled");
		expect(data).not.toHaveProperty("status");
		expect(data).not.toHaveProperty("enforcement_status");
		expect(data).not.toHaveProperty("current_usage_cents");
		expect(data.notice).toContain("unavailable or unsupported");
	});

	test("preserves additive GET status strings and the backend warning", async () => {
		const { tools, requests } = setup(additiveStatus);
		const { data } = await tools["organizations.spendingLimit.get"].execute(
			{ org_id: "org-1" },
		);
		expect(data).toMatchObject(additiveStatus);
		expect(requests.map((request) => request.method)).toEqual(["GET"]);
	});

	test("preserves a successful PUT and its warning with additive status strings", async () => {
		const { tools, requests } = setup(additiveStatus);
		const { data } = await tools["organizations.spendingLimit.set"].execute(
			{
				org_id: "org-1",
				spending_limit_cents: 10000,
				spend_cap_enabled: true,
			},
		);
		expect(data).toMatchObject(additiveStatus);
		expect(data.notice).toContain("Configuration accepted");
		expect(requests.map((request) => request.method)).toEqual(["PUT"]);
	});

	test("retains null usage instead of treating missing observations as zero", async () => {
		const { tools } = setup({
			...fullStatus,
			current_usage_cents: null,
			usage_observed_at: null,
		});
		const { data } = await tools["organizations.spendingLimit.get"].execute(
			{ org_id: "org-1" },
		);
		expect(data.current_usage_cents).toBeNull();
		expect(data.usage_observed_at).toBeNull();
	});

	test.each([
		undefined,
		true,
		false,
	])("forwards explicit opt-in %s without defaulting the omitted boolean", async (enabled) => {
		const { tools, requests } = setup();
		const input = {
			org_id: "org-1",
			spending_limit_cents: 10000,
			...(enabled === undefined ? {} : { spend_cap_enabled: enabled }),
		};
		const { data } =
			await tools["organizations.spendingLimit.set"].execute(input);
		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe("PUT");
		const { org_id: _, ...body } = input;
		expect(await requests[0].json()).toEqual(body);
		expect(data.warning).toBe(fullStatus.warning);
		expect(data.enforcement_status).toBe("pending");
		expect(data.notice).toContain("Configuration accepted");
	});

	test.each([
		0,
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
		Infinity,
		NaN,
		"100.00",
		null,
	])("refuses invalid cents %s before any API call", async (amount) => {
		const { tools, requests } = setup();
		await expect(
			Reflect.apply(
				tools["organizations.spendingLimit.set"].execute,
				undefined,
				[{ org_id: "org-1", spending_limit_cents: amount }],
			),
		).rejects.toThrow();
		expect(requests).toHaveLength(0);
	});

	test.each([
		1,
		Number.MAX_SAFE_INTEGER,
	])("round-trips exact boundary cents %s", async (amount) => {
		const { tools, requests } = setup({ spending_limit_cents: amount });
		const { data } = await tools["organizations.spendingLimit.set"].execute(
			{ org_id: "org-1", spending_limit_cents: amount },
		);
		expect(data.spending_limit_cents).toBe(amount);
		expect(await requests[0].json()).toEqual({
			spending_limit_cents: amount,
		});
	});

	test.each([
		"spending_limit_cents",
		"current_usage_cents",
		"generation",
	])("refuses an unsafe API %s rather than returning rounded data", async (field) => {
		const { tools } = setup({
			...fullStatus,
			[field]: Number.MAX_SAFE_INTEGER + 1,
		});
		await expect(
			tools["organizations.spendingLimit.get"].execute({
				org_id: "org-1",
			}),
		).rejects.toThrow();
	});

	test("disable sends one authenticated bodyless POST without requiring observed usage", async () => {
		const { tools, requests } = setup({ spending_limit_cents: 15325 });
		const tool = tools["organizations.spendingLimit.disable"];
		const { data } = await tool.execute({
			org_id: "org-1",
		});
		expect(requests.map((r) => r.method)).toEqual(["POST"]);
		expect(requests[0].url).toBe(
			"https://example.test/api/v2/organizations/org-1/billing/spending_limit/disable",
		);
		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer test-key",
		);
		expect(await requests[0].text()).toBe("");
		expect(data.spending_limit_cents).toBe(15325);
		expect(tool.metadata).toMatchObject({
			method: "POST",
			path: "/organizations/{org_id}/billing/spending_limit/disable",
			readOnlySafe: false,
		});
	});

	test("disable leaves an unset amount unset without inventing status", async () => {
		const { tools, requests } = setup({ spending_limit_cents: null });
		const { data } = await tools[
			"organizations.spendingLimit.disable"
		].execute({ org_id: "org-1" });
		expect(requests.map((r) => r.method)).toEqual(["POST"]);
		expect(await requests[0].text()).toBe("");
		expect(data.spending_limit_cents).toBeNull();
		expect(data).not.toHaveProperty("spend_cap_enabled");
	});

	test.each([
		20000,
		null,
	])("disable preserves a concurrent threshold change to %s", async (amount) => {
		let current: {
			spending_limit_cents: number | null;
			spend_cap_enabled: boolean;
		} = {
			spending_limit_cents: 10000,
			spend_cap_enabled: true,
		};
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["organizations.spendingLimit.disable"],
			fetch: async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				const snapshot = { ...current };
				if (requests.length === 1)
					current.spending_limit_cents = amount;
				if (request.method === "POST")
					current.spend_cap_enabled = false;
				if (request.method === "PUT")
					current = { ...current, ...(await request.json()) };
				return new Response(
					JSON.stringify(
						request.method === "GET" ? snapshot : current,
					),
					{
						headers: { "content-type": "application/json" },
					},
				);
			},
		});
		const { data } = await tools[
			"organizations.spendingLimit.disable"
		].execute({ org_id: "org-1" });
		expect(current).toEqual({
			spending_limit_cents: amount,
			spend_cap_enabled: false,
		});
		expect(data.spending_limit_cents).toBe(amount);
		expect(requests.map((r) => r.method)).toEqual(["POST"]);
		expect(await requests[0].text()).toBe("");
	});

	test.each([
		403, 404, 405, 423, 429, 501, 503,
	])("disable surfaces HTTP %s without fallback or retry", async (status) => {
		const { tools, requests } = setup(
			{
				code: "DISABLE_UNAVAILABLE",
				message: "Disable request rejected",
			},
			status,
		);
		await expect(
			tools["organizations.spendingLimit.disable"].execute({
				org_id: "org-1",
			}),
		).rejects.toMatchObject({ status });
		expect(requests.map((r) => r.method)).toEqual(["POST"]);
		expect(await requests[0].text()).toBe("");
	});

	test.each([
		"organizations.spendingLimit.set",
		"organizations.spendingLimit.disable",
	] as const)("%s refuses read-only execution before network access", async (selector) => {
		const { tools, requests } = setup();
		await expect(
			tools[selector].execute(
				{ org_id: "org-1", spending_limit_cents: 10000 },
				{ readOnly: true },
			),
		).rejects.toThrow("read-only");
		expect(requests).toHaveLength(0);
		expect(tools[selector].annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
		});
	});

	test.each([
		"SPEND_CAP_EXCEEDED",
		"INSUFFICIENT_ORG_PERMISSIONS",
	])("preserves 403 %s without retrying", async (code) => {
		const { tools, requests } = setup(
			{ code, message: "Denied by policy" },
			403,
		);
		await expect(
			tools["organizations.spendingLimit.disable"].execute({
				org_id: "org-1",
			}),
		).rejects.toMatchObject({ code, status: 403, name: "NeonAuthError" });
		expect(requests).toHaveLength(1);
		await expect(
			tools["organizations.spendingLimit.set"].execute({
				org_id: "org-1",
				spending_limit_cents: 10000,
			}),
		).rejects.toBeInstanceOf(NeonAuthError);
		expect(requests).toHaveLength(2);
	});
});
