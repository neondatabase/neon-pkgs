import { log } from "../log.js";

/**
 * Friendly guidance shown when a branch enables the AI Gateway (`aiGateway`).
 *
 * The gateway is credential-gated, not provisioned: enabling it always mints a working
 * branch credential, so `apply` / `checkout` / `env pull` succeed on every plan. Whether the
 * account can *serve* model requests is decided at request time and is invisible in the
 * provisioning result, so the branch's own `/v1/models` is read and surfaced as a courtesy
 * notice instead:
 *
 *  - **No enabled models** — the account can't serve any model yet, most commonly because it
 *    has no AI Gateway credits. The gateway reports the reason and the Console page that
 *    fixes it on every disabled model.
 *  - **Reduced model set** — an account still ramping up gets a trimmed model catalog
 *    (flagship models are listed but `enabled: false`). They can request access to more
 *    models.
 *
 * This is deliberately phrased for the user: it never mentions account "verification" or any
 * other internal gating mechanism.
 */

/** `unavailable_reason` the gateway reports when the account has no AI Gateway credits. */
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

/**
 * Build the AI Gateway courtesy notice from the branch's live model catalog, or `null` when
 * nothing needs saying. `catalog` is `undefined` when it couldn't be read, which keeps the
 * notice silent rather than risking a false warning. `moreModelsUrl` is the branch's Console
 * AI Gateway page (see {@link aiGatewayModelsUrl}), shown when the catalog is reduced.
 */
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
 * Read an OpenAI-compatible `{ object: "list", data: [{ id, enabled, ... }] }` body. The
 * gateway lists every model in the catalog but marks ones the account can't serve yet with
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

/**
 * `GET {baseUrl}/v1/models` → the parsed catalog, or `null` if it can't be read (network /
 * HTTP / parse failure). Returning `null` keeps the notice silent rather than risking a false
 * warning. `/v1/models` is served only on the unified dialect (the `/openai/v1` Responses
 * dialect returns 404).
 */
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

/**
 * Read the branch's live model catalog with the freshly pulled gateway credentials and print
 * the AI Gateway courtesy notice — used by `env pull` (and every command that bundles one)
 * whenever a branch has the gateway enabled. Best-effort: it never breaks the command.
 */
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
