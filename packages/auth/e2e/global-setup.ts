import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ProvisionedNeonAuth,
	provisionNeonAuth,
	releaseNeonAuth,
} from "@neon/e2e-harness/auth";
// Subpath, never the barrel: the root export pulls in the `e2eTest` fixture, which
// imports `vitest`, and `globalSetup` runs outside a worker where that throws.
import { loadEnv } from "@neon/e2e-harness/env";

/**
 * Put a live Neon Auth service in front of the suite, once per run. There is no
 * bring-your-own path: every test needs a service whose email verification is off and
 * whose users it creates, so it always provisions from `NEON_API_KEY` — a throwaway
 * project, Neon Auth enabled on its default branch, both deleted afterwards.
 *
 * This runs in Vitest's main process before the worker pool is forked, so the
 * `NEON_AUTH_BASE_URL` / `NEON_AUTH_JWKS_URL` values it sets are inherited by every
 * test file. Doing it in a setup file instead would provision one project per file.
 */
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default async function setup(): Promise<() => Promise<void>> {
	loadEnv(packageDir);

	let auth: ProvisionedNeonAuth;
	try {
		auth = await provisionNeonAuth();
	} catch (err) {
		throw new Error(
			"Could not provision Neon Auth for the e2e run. Set NEON_API_KEY (an org-scoped " +
				"key for a throwaway org, see .env.example) — the suite has no credentials-free " +
				"mode, because a green run of zero tests is exactly the failure it exists to prevent.",
			{ cause: err },
		);
	}
	// Neither URL is a credential, so there is nothing to mask the way the gateway suite
	// masks its minted token — the API key GitHub already redacts as a repository secret.
	console.info(
		`[auth e2e] project ${auth.projectId}, auth service at ${auth.baseUrl}`,
	);
	process.env.NEON_AUTH_BASE_URL = auth.baseUrl;
	process.env.NEON_AUTH_JWKS_URL = auth.jwksUrl;

	return async () => {
		await releaseNeonAuth(auth);
	};
}
