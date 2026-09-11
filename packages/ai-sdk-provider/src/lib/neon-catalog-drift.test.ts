import { describe, expect, it } from "vitest";
import { NEON_MODELS_DEV_IDS } from "./neon-chat-options.js";
import { getNeonModelCapabilities } from "./neon-model-capabilities.js";

/**
 * Maintainer-only guard against catalog drift. https://neon.com/models.json is
 * the published catalog this package's typed id list must match; this test
 * fails when `NEON_MODELS_DEV_IDS` no longer mirrors it.
 *
 * It hits the network, so it is opt-in: it runs only when `NEON_DRIFT_CHECK=1`
 * (see the `test:drift` script and the scheduled `catalog-drift` CI workflow),
 * and is skipped by the normal unit-test run / PR CI to keep those offline and
 * deterministic.
 */
const ENABLED = process.env.NEON_DRIFT_CHECK === "1";
const NEON_MODELS_JSON = "https://neon.com/models.json";

interface NeonModelsJson {
	neon?: { models?: Record<string, unknown> };
}

async function fetchNeonCatalogModels(): Promise<Record<string, unknown>> {
	const response = await fetch(NEON_MODELS_JSON);
	if (!response.ok) {
		throw new Error(
			`neon.com/models.json returned ${response.status} ${response.statusText}`,
		);
	}
	const data: NeonModelsJson = await response.json();
	const models = data.neon?.models;
	if (models == null) {
		throw new Error("neon.com/models.json has no neon.models");
	}
	return models;
}

function catalogTemperature(entry: unknown): boolean {
	if (entry === null || typeof entry !== "object") {
		throw new Error("neon.com/models.json model entry is not an object");
	}
	if (!("temperature" in entry) || typeof entry.temperature !== "boolean") {
		throw new Error("neon.com/models.json temperature is not a boolean");
	}
	return entry.temperature;
}

describe.skipIf(!ENABLED)("neon.com/models.json catalog drift", () => {
	it("keeps NEON_MODELS_DEV_IDS in sync with the published catalog", async () => {
		const live = new Set(Object.keys(await fetchNeonCatalogModels()));
		expect(live.size).toBeGreaterThan(0);

		const declared = new Set<string>(NEON_MODELS_DEV_IDS);
		const missingFromProvider = [...live]
			.filter((id) => !declared.has(id))
			.sort();
		const removedUpstream = [...declared]
			.filter((id) => !live.has(id))
			.sort();

		// `missingFromProvider`: add these to NEON_MODELS_DEV_IDS.
		// `removedUpstream`: neon.com/models.json dropped these; remove them from the array.
		expect({ missingFromProvider, removedUpstream }).toEqual({
			missingFromProvider: [],
			removedUpstream: [],
		});
	});

	it("keeps gpt-6-astra temperature aligned with the catalog", async () => {
		const models = await fetchNeonCatalogModels();
		const catalog = catalogTemperature(models["gpt-6-astra"]);
		const reported =
			getNeonModelCapabilities("gpt-6-astra").supportsTemperature;
		expect({ catalog, reported }).toEqual({
			catalog: false,
			reported: false,
		});
	});
});
