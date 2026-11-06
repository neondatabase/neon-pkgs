import { log } from "../log.js";

/**
 * A minted gateway credential says nothing about whether the account can serve a model:
 * that is decided per request, so the branch's own `/v1/models` is the only source for it.
 */

/** Despite the name, adding a card and buying AI Gateway credits clears it on any plan. */
const CREDITS_REQUIRED_REASON = "paid_plan_required";

const PREPAID_CREDITS_DOCS_URL =
	"https://neon.com/docs/ai-gateway/prepaid-credits";

/**
 * The branch's AI Gateway page in the Neon Console — where a user with a reduced model set
 * requests access to more models. It's branch-scoped, so it's built from the linked project
 * and branch ids.
 */
export const aiGatewayModelsUrl = (
	projectId: string,
	branchId: string,
): string =>
	`https://console.neon.tech/app/projects/${projectId}/branches/${branchId}/ai-gateway`;

/**
 * Whether the model catalog includes at least one flagship model enabled. Flagship models
 * (Anthropic Opus, OpenAI Codex / `*-pro`) are the first to be held back for an account still
 * ramping up on the beta, so their total absence from a non-empty enabled set is the signal
 * that the account has a reduced model set. Matched by id substring so it survives model
 * version bumps (e.g. `claude-opus-4-8`).
 */
export const hasFlagshipModels = (modelIds: readonly string[]): boolean =>
	modelIds.some(
		(id) =>
			id.includes("opus") || id.includes("codex") || id.endsWith("-pro"),
	);

export type GatewayCatalog = {
	enabledIds: string[];
	/** Why the first disabled model can't be served, as reported by the gateway. */
	unavailable?: { reason: string; recoveryUrl?: string };
};

export type AiGatewayNotice = {
	level: "warning";
	message: string;
};

const noEnabledModelsMessage = (unavailable: {
	reason: string;
	recoveryUrl?: string;
}): string => {
	if (unavailable.reason === CREDITS_REQUIRED_REASON) {
		return (
			"AI Gateway is enabled, but no models are available to this account until it has " +
			"AI Gateway credits. Credits work on every Neon plan, including Free. Add a card and " +
			`buy credits on the Billing page: ${unavailable.recoveryUrl ?? PREPAID_CREDITS_DOCS_URL}`
		);
	}
	return (
		"AI Gateway is enabled, but no models are available to this account yet " +
		`(${unavailable.reason}). ` +
		(unavailable.recoveryUrl
			? `Resolve it here: ${unavailable.recoveryUrl}`
			: "See https://neon.com/docs/ai-gateway/troubleshooting")
	);
};

/** An unreadable catalog (`undefined`) stays silent rather than risk a false warning. */
export const buildAiGatewayNotice = ({
	catalog,
	moreModelsUrl,
}: {
	catalog: GatewayCatalog | undefined;
	moreModelsUrl: string;
}): AiGatewayNotice | null => {
	if (catalog === undefined) return null;
	if (catalog.enabledIds.length === 0) {
		return catalog.unavailable
			? {
					level: "warning",
					message: noEnabledModelsMessage(catalog.unavailable),
				}
			: null;
	}
	if (!hasFlagshipModels(catalog.enabledIds)) {
		return {
			level: "warning",
			message:
				"Not every model is enabled for your account " +
				"yet, so some models are missing from the catalog. Request access to more " +
				`models here: ${moreModelsUrl}`,
		};
	}
	return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * The gateway lists every catalog model, and marks the ones the account can't serve with
 * `enabled: false`, an `unavailable_reason`, and a `recovery_url`.
 */
export const parseGatewayCatalog = (body: unknown): GatewayCatalog | null => {
	if (!isRecord(body) || !Array.isArray(body.data)) return null;
	const enabledIds: string[] = [];
	let unavailable: GatewayCatalog["unavailable"];
	for (const entry of body.data) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		if (entry.enabled === true) {
			enabledIds.push(entry.id);
		} else if (
			unavailable === undefined &&
			typeof entry.unavailable_reason === "string"
		) {
			unavailable = {
				reason: entry.unavailable_reason,
				...(typeof entry.recovery_url === "string"
					? { recoveryUrl: entry.recovery_url }
					: {}),
			};
		}
	}
	return unavailable ? { enabledIds, unavailable } : { enabledIds };
};

/** `/v1/models` is served only on the unified dialect; `/openai/v1` returns 404. */
export const fetchGatewayCatalog = async (
	baseUrl: string,
	token: string,
): Promise<GatewayCatalog | null> => {
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) return null;
		return parseGatewayCatalog(await res.json());
	} catch {
		return null;
	}
};

/** A courtesy notice: no failure here may fail the env pull that called it. */
export const warnAiGateway = async (params: {
	projectId: string;
	branchId: string;
	gateway: { baseUrl: string; token: string };
}): Promise<void> => {
	const catalog = await fetchGatewayCatalog(
		params.gateway.baseUrl,
		params.gateway.token,
	);
	const notice = buildAiGatewayNotice({
		catalog: catalog ?? undefined,
		moreModelsUrl: aiGatewayModelsUrl(params.projectId, params.branchId),
	});
	if (notice) log.warning(notice.message);
};
