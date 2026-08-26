/**
 * Routes a `--data` payload to a phase handler by its `step` field, without
 * shelling out. This is the whole agent-facing surface of `neon init`:
 *
 *   neon init --agent --data '{"step":"auth"}'
 *   neon init --agent --data '{"step":"setup","mode":"defaults"}'
 */
export async function routeDataStep(
	data: Record<string, unknown>,
	agent: string | undefined,
): Promise<unknown> {
	const { step, agentId, ...rest } = data;

	// Allow agentId override from data JSON, fall back to caller-provided agent
	const resolvedAgent = typeof agentId === "string" ? agentId : agent;

	// Agents sometimes nest the actual payload inside a "data" key:
	//   {"step":"setup","data":{"mode":"defaults",...}}
	// or as a JSON string:
	//   {"step":"setup","data":"{\"mode\":\"defaults\",...}"}
	// Unwrap it so the phase handler gets the right options.
	if (rest.data !== undefined && Object.keys(rest).length === 1) {
		let nested = rest.data;
		if (typeof nested === "string") {
			try {
				nested = JSON.parse(nested);
			} catch {
				// leave as-is
			}
		}
		if (typeof nested === "object" && nested !== null) {
			Object.assign(rest, nested);
			delete rest.data;
		}
	}

	switch (step) {
		case "auth": {
			const { handleAuthPhase } = await import("./phases/auth.js");
			return handleAuthPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleAuthPhase>[0]);
		}

		case "setup": {
			const { handleSetupPhase } = await import("./phases/setup.js");
			return handleSetupPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleSetupPhase>[0]);
		}

		case "mcp": {
			const { handleMcpPhase } = await import("./phases/mcp.js");
			return handleMcpPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleMcpPhase>[0]);
		}

		case "skills": {
			const { handleSkillsPhase } = await import("./phases/skills.js");
			return handleSkillsPhase({
				agent: resolvedAgent,
				...rest,
			} as Parameters<typeof handleSkillsPhase>[0]);
		}

		default:
			throw new Error(
				`Unknown step: "${step}". Valid steps: auth, setup, mcp, skills`,
			);
	}
}
