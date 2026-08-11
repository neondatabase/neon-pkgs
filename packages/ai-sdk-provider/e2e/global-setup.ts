import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "@neon/e2e-harness/env";
import {
	type ProvisionedGateway,
	provisionGateway,
	releaseGateway,
} from "./provision-gateway.js";

/**
 * Put a live AI Gateway in front of the suite, once per run.
 *
 * Two ways in, and nothing in between:
 *
 * - `NEON_AI_GATEWAY_BASE_URL` + `NEON_AI_GATEWAY_TOKEN` — run against a branch you already
 *   have. Nothing is created or deleted.
 * - `NEON_API_KEY` (+ `NEON_ORG_ID`) — the suite creates a throwaway project in that org,
 *   mints a scoped gateway credential, and removes both afterwards. This is how CI runs: the
 *   gateway token is minted per run rather than stored as a repository secret.
 *
 * This runs in Vitest's main process before the worker pool is forked, so the values it puts
 * on `process.env` are inherited by every test file. It has to happen here rather than in a
 * setup file: setup files run once per test file, which would provision three projects, and
 * `gateway-matrix` reads the served catalog while its module is still being imported.
 */
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function overrideCredentials(): { baseUrl: string; token: string } | undefined {
	const baseUrl = process.env.NEON_AI_GATEWAY_BASE_URL?.trim();
	const token = process.env.NEON_AI_GATEWAY_TOKEN?.trim();
	if (baseUrl && token) return { baseUrl, token };
	if (baseUrl || token) {
		throw new Error(
			"Set both NEON_AI_GATEWAY_BASE_URL and NEON_AI_GATEWAY_TOKEN, or neither. " +
				"One without the other would silently run against a different branch than intended.",
		);
	}
	return undefined;
}

export default async function setup(): Promise<() => Promise<void>> {
	loadEnv(packageDir);

	const override = overrideCredentials();
	if (override) {
		console.info(
			`[gateway e2e] using the configured gateway at ${override.baseUrl}`,
		);
		return async () => {};
	}

	let gateway: ProvisionedGateway;
	try {
		gateway = await provisionGateway();
	} catch (err) {
		throw new Error(
			"Could not provision an AI Gateway for the e2e run. Set NEON_API_KEY (an org-scoped key " +
				"for a throwaway org, see .env.example), or point NEON_AI_GATEWAY_BASE_URL and " +
				"NEON_AI_GATEWAY_TOKEN at a branch you already have.",
			{ cause: err },
		);
	}
	console.info(
		`[gateway e2e] provisioned project ${gateway.projectId} for branch ${gateway.branchId}`,
	);
	process.env.NEON_AI_GATEWAY_BASE_URL = gateway.baseUrl;
	process.env.NEON_AI_GATEWAY_TOKEN = gateway.token;

	return async () => {
		await releaseGateway(gateway);
	};
}
