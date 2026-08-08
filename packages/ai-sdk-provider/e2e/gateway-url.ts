/**
 * The AI Gateway lives on a **branch-scoped host** — `<branchId>-api.ai.<suffix>` — derived
 * from the branch's own Postgres host by dropping only the endpoint label (the first DNS
 * segment) and keeping everything after it. The `c-N.` infra cell prefix is load-bearing:
 * the gateway is cell-routed, so dropping it resolves to the wrong host or none at all.
 *
 * This mirrors the private `aiGatewayHost` in `packages/env/src/lib/env.ts`. The duplication
 * is deliberate — `@neon/env` is itself a package under live test, and setup plumbing built
 * on a package under test breaks teardown at exactly the moment a test catches a bug in it.
 */
export function gatewayBaseUrl(branchId: string, endpointHost: string): string {
	const suffix = endpointHost.split(".").slice(1).join(".");
	if (suffix === "") {
		throw new Error(
			`Cannot derive an AI Gateway host from endpoint host "${endpointHost}": no domain left after the endpoint label.`,
		);
	}
	return `https://${branchId}-api.ai.${suffix}`;
}
