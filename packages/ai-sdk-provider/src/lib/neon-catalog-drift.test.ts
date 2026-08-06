import { describe, expect, it } from "vitest";
import { NEON_MODELS_DEV_IDS } from "./neon-chat-options.js";

/**
 * Maintainer-only guard against models.dev drift. The `neon` provider on
 * models.dev is the source of truth for the gateway's published catalog; this
 * test fails when our `NEON_MODELS_DEV_IDS` no longer mirrors it.
 *
 * It hits the network, so it is opt-in: it runs only when `NEON_DRIFT_CHECK=1`
 * (see the `test:drift` script and the scheduled `catalog-drift` CI workflow),
 * and is skipped by the normal unit-test run / PR CI to keep those offline and
 * deterministic.
 */
const ENABLED = process.env.NEON_DRIFT_CHECK === "1";
const MODELS_DEV_API = "https://models.dev/api.json";

interface ModelsDevApi {
	neon?: { models?: Record<string, unknown> };
}

async function fetchNeonCatalogIds(): Promise<Set<string>> {
	const response = await fetch(MODELS_DEV_API);
	if (!response.ok) {
		throw new Error(
			`models.dev returned ${response.status} ${response.statusText}`,
		);
	}
	const data: ModelsDevApi = await response.json();
	const models = data.neon?.models;
	if (models == null) {
		throw new Error("models.dev response has no `neon` provider models");
	}
	return new Set(Object.keys(models));
}

describe.skipIf(!ENABLED)("models.dev catalog drift", () => {
	it("keeps NEON_MODELS_DEV_IDS in sync with the live neon catalog", async () => {
		const live = await fetchNeonCatalogIds();
		expect(live.size).toBeGreaterThan(0);

		const declared = new Set<string>(NEON_MODELS_DEV_IDS);
		const missingFromProvider = [...live]
			.filter((id) => !declared.has(id))
			.sort();
		const removedUpstream = [...declared]
			.filter((id) => !live.has(id))
			.sort();

		// `missingFromProvider`: add these to NEON_MODELS_DEV_IDS.
		// `removedUpstream`: models.dev dropped these — remove or move to extras.
		expect({ missingFromProvider, removedUpstream }).toEqual({
			missingFromProvider: [],
			removedUpstream: [],
		});
	});
});
