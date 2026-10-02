import { describe, expect, it } from "vitest";
import { NEON_MODELS_DEV_IDS } from "./neon-chat-options.js";
import { NEON_EMBEDDING_MODEL_IDS } from "./neon-embedding-options.js";
import { getNeonModelCapabilities } from "./neon-model-capabilities.js";

/**
 * Maintainer-only guard against catalog drift. https://neon.com/models.json is
 * the published catalog this package's typed id lists must match; this test
 * fails when `NEON_MODELS_DEV_IDS` (chat) or `NEON_EMBEDDING_MODEL_IDS`
 * (`"type": "embedding"` entries) no longer mirror it.
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

function isEmbeddingEntry(entry: unknown): boolean {
	return (
		entry !== null &&
		typeof entry === "object" &&
		"type" in entry &&
		entry.type === "embedding"
	);
}

function compareIds(live: readonly string[], declared: readonly string[]) {
	const liveSet = new Set(live);
	const declaredSet = new Set(declared);
	return {
		missingFromProvider: live.filter((id) => !declaredSet.has(id)).sort(),
		removedUpstream: declared.filter((id) => !liveSet.has(id)).sort(),
	};
}

describe.skipIf(!ENABLED)("neon.com/models.json catalog drift", () => {
	it("keeps NEON_MODELS_DEV_IDS in sync with the published chat catalog", async () => {
		const entries = Object.entries(await fetchNeonCatalogModels());
		const live = entries
			.filter(([, entry]) => !isEmbeddingEntry(entry))
			.map(([id]) => id);
		expect(live.length).toBeGreaterThan(0);

		// `missingFromProvider`: add these to NEON_MODELS_DEV_IDS.
		// `removedUpstream`: neon.com/models.json dropped these; remove them from the array.
		expect(compareIds(live, NEON_MODELS_DEV_IDS)).toEqual({
			missingFromProvider: [],
			removedUpstream: [],
		});
	});

	it("keeps NEON_EMBEDDING_MODEL_IDS in sync with the published embedding catalog", async () => {
		const entries = Object.entries(await fetchNeonCatalogModels());
		const live = entries
			.filter(([, entry]) => isEmbeddingEntry(entry))
			.map(([id]) => id);
		expect(live.length).toBeGreaterThan(0);

		expect(compareIds(live, NEON_EMBEDDING_MODEL_IDS)).toEqual({
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
