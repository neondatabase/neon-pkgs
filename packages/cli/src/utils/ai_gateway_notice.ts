import type { NeonApiClient } from "../api.js";
import { log } from "../log.js";

/**
 * Friendly guidance shown when a branch enables the AI Gateway (`preview.aiGateway`).
 *
 * The gateway is credential-gated, not provisioned: enabling it always mints a working
 * branch credential, so `apply` / `checkout` / `env pull` succeed regardless of plan. The
 * two things that *do* gate the gateway happen at serving time and are invisible in the
 * provisioning result, so we surface them as a courtesy notice instead:
 *
 *  - **Free plan** — credentials provision, but the gateway does not *serve* model requests.
 *    The account needs to upgrade to a paid plan.
 *  - **Reduced model set** — on a paid plan, an account still ramping up on the beta gets a
 *    trimmed model catalog (flagship models are listed but `enabled: false` on `/v1/models`).
 *    They can request access to more models.
 *
 * This is deliberately phrased for the user: it never mentions account "verification" or any
 * other internal gating mechanism.
 */

/**
 * `BillingSubscriptionType` values that mean the account is on a Free plan (the gateway
 * won't serve requests). Everything else — `launch`, `scale`, `business`, the `*_v3`
 * variants, marketplace plans — is treated as paid.
 */
const FREE_SUBSCRIPTION_TYPES = new Set(["free_v2", "free_v3"]);

/**
 * The Neon Console billing page to upgrade a Free-plan account so the gateway can serve. It's
 * org-scoped when the project belongs to an org; projects on a personal account (which is
 * where Free plans usually live) have no org id, so we fall back to the account-level page.
 */
export const aiGatewayUpgradeUrl = (orgId: string | undefined): string =>
	orgId
		? `https://console.neon.tech/app/${orgId}/billing`
		: "https://console.neon.tech/app/billing";

/**
 * The branch's AI Gateway page in the Neon Console — where a paid user with a reduced model
 * set requests access to more models. It's branch-scoped, so it's built from the linked
 * project and branch ids.
 */
export const aiGatewayModelsUrl = (
	projectId: string,
	branchId: string,
): string =>
	`https://console.neon.tech/app/projects/${projectId}/branches/${branchId}/ai-gateway`;

export const isFreePlan = (subscriptionType: string | undefined): boolean =>
	subscriptionType !== undefined &&
	FREE_SUBSCRIPTION_TYPES.has(subscriptionType);

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

export type AiGatewayNotice = {
	level: "warning";
	message: string;
};

/**
 * The message shown when a `neon.ts` that enables the AI Gateway is applied on a Free plan.
 * Provisioning is refused up front (see {@link assertAiGatewayProvisionable}) because the
 * gateway won't serve model requests until the account is on a paid plan. `upgradeUrl` is the
 * org-scoped Console billing page (see {@link aiGatewayUpgradeUrl}).
 */
export const freePlanBlockMessage = (upgradeUrl: string): string =>
	"This neon.ts enables the AI Gateway, which isn't available on the Free plan — the " +
	"gateway won't serve model requests. Upgrade to a paid plan and re-run, or remove " +
	`\`preview.aiGateway\` from neon.ts. Upgrade here: ${upgradeUrl}`;

/**
 * Build the AI Gateway courtesy notice for an account's plan and (optionally) its live model
 * catalog, or `null` when nothing needs saying.
 *
 * `modelIds` is `undefined` when the catalog wasn't probed (e.g. a dry-run `plan`, or a probe
 * that failed); in that case only the plan-based (Free) notice can be produced — never a
 * false "reduced models" warning. `upgradeUrl` is the org-scoped Console billing page
 * (Free notice); `moreModelsUrl` is the branch's Console AI Gateway page
 * (see {@link aiGatewayModelsUrl}), shown when the catalog is reduced.
 */
export const buildAiGatewayNotice = ({
	subscriptionType,
	modelIds,
	upgradeUrl,
	moreModelsUrl,
}: {
	subscriptionType: string | undefined;
	modelIds?: readonly string[];
	upgradeUrl: string;
	moreModelsUrl: string;
}): AiGatewayNotice | null => {
	if (isFreePlan(subscriptionType)) {
		return {
			level: "warning",
			message:
				"AI Gateway is enabled, but the gateway does not serve model requests on the " +
				`Free plan. Upgrade to a paid plan to start making requests: ${upgradeUrl}`,
		};
	}
	if (
		modelIds !== undefined &&
		modelIds.length > 0 &&
		!hasFlagshipModels(modelIds)
	) {
		return {
			level: "warning",
			message:
				"AI Gateway is in public beta and not every model is enabled for your account " +
				"yet, so some models are missing from the catalog. Request access to more " +
				`models here: ${moreModelsUrl}`,
		};
	}
	return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * Pull the `id`s of enabled models out of an OpenAI-compatible
 * `{ object: "list", data: [{ id, enabled, ... }] }` body. The gateway lists every model in
 * the catalog but marks ones the account can't serve yet with `enabled: false`; only the
 * enabled set is used to detect a reduced catalog.
 */
export const extractEnabledModelIds = (body: unknown): string[] | null => {
	if (!isRecord(body) || !Array.isArray(body.data)) return null;
	const ids: string[] = [];
	for (const entry of body.data) {
		if (
			isRecord(entry) &&
			typeof entry.id === "string" &&
			entry.enabled === true
		) {
			ids.push(entry.id);
		}
	}
	return ids;
};

/**
 * `GET {baseUrl}/v1/models` → the enabled model ids, or `null` if the catalog can't be read
 * (network / HTTP / parse failure). Returning `null` keeps the notice silent rather than
 * risking a false "reduced models" warning. `/v1/models` is served only on the unified
 * dialect (the `/openai/v1` Responses dialect returns 404).
 */
export const fetchGatewayModelIds = async (
	baseUrl: string,
	token: string,
): Promise<string[] | null> => {
	try {
		const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/models`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) return null;
		return extractEnabledModelIds(await res.json());
	} catch {
		return null;
	}
};

/**
 * Refuse to provision the AI Gateway on a Free plan. Called before the `neon.ts` lifecycle
 * commands provision a branch (`config apply` / `deploy`, `checkout`), so a Free-plan user
 * gets a clear "upgrade first" error instead of a credential that can't serve requests.
 *
 * Best-effort on the plan lookup: if the plan can't be determined (network / API failure) we
 * do NOT block, so a transient error never wrongly refuses a paid user's deploy. Only a
 * positively-identified Free plan throws.
 */
export const assertAiGatewayProvisionable = async (params: {
	apiClient: NeonApiClient;
	projectId: string;
}): Promise<void> => {
	let subscriptionType: string | undefined;
	let orgId: string | undefined;
	try {
		const { data } = await params.apiClient.getProject(params.projectId);
		subscriptionType = data.project.owner?.subscription_type;
		orgId = data.project.org_id ?? undefined;
	} catch {
		return; // Can't determine the plan — don't block.
	}
	if (isFreePlan(subscriptionType)) {
		throw new Error(freePlanBlockMessage(aiGatewayUpgradeUrl(orgId)));
	}
};

/**
 * Resolve the account's plan (and, when gateway credentials are on hand, its live model
 * catalog) and print the AI Gateway courtesy notice — used by the `neon.ts` lifecycle and
 * `env pull` whenever a branch has the gateway enabled.
 *
 * Pass `gateway` (base URL + token) to enable the reduced-model-set check; omit it (e.g. a
 * dry-run `plan`) to get only the Free-plan notice. This is best-effort: any failure while
 * fetching the plan or catalog is swallowed so it can never break the underlying command.
 */
export const warnAiGateway = async (params: {
	apiClient: NeonApiClient;
	projectId: string;
	branchId: string;
	gateway?: { baseUrl: string; token: string };
}): Promise<void> => {
	try {
		const { data } = await params.apiClient.getProject(params.projectId);
		const subscriptionType = data.project.owner?.subscription_type;
		const orgId = data.project.org_id ?? undefined;
		const modelIds = params.gateway
			? ((await fetchGatewayModelIds(
					params.gateway.baseUrl,
					params.gateway.token,
				)) ?? undefined)
			: undefined;
		const notice = buildAiGatewayNotice({
			subscriptionType,
			modelIds,
			upgradeUrl: aiGatewayUpgradeUrl(orgId),
			moreModelsUrl: aiGatewayModelsUrl(
				params.projectId,
				params.branchId,
			),
		});
		if (notice) log.warning(notice.message);
	} catch {
		// A courtesy notice must never break the command that triggered it.
	}
};
