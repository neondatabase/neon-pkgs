import type { CurrentUserInfoResponse } from "@neon/sdk";
import type yargs from "yargs";

import { isNeonApiError, type NeonApiClient } from "../api.js";
import { type AuthContext, getAuthContext } from "../auth_context.js";
import type { CommonProps } from "../types.js";
import { writer } from "../writer.js";

export const command = "me";
export const describe =
	"Show the current user, organization, or Claimable project";
export const builder = (yargs: yargs.Argv) =>
	yargs.option("context-file", {
		hidden: true,
	});
export const handler = async (args: CommonProps) => {
	await me(args);
};

const me = async (props: CommonProps) => {
	// No client means `ensureAuth` found no credential and already reported it.
	if (!props.apiClient) return;
	const auth = getAuthContext();
	// Claimable Neon has no user or organization to return, and serves no `/users/me` or `/auth`.
	if (auth?.source === "claimable" && auth.claimableProject) {
		const identity = {
			auth_method: "claimable",
			project_id: auth.claimableProject.id,
			project_expires_at: auth.claimableProject.expiresAt,
		};
		if (props.output === "json" || props.output === "yaml") {
			writer(props).end(identity, {
				fields: ["auth_method", "project_id", "project_expires_at"],
			});
			return;
		}
		writer(props).end(
			{ ...identity, authentication: authenticationLabel(auth) },
			{ fields: ["project_id", "project_expires_at", "authentication"] },
		);
		return;
	}
	const data = await currentUserOrOrgKey(props.apiClient);
	if ("auth_method" in data) {
		if (props.output === "json" || props.output === "yaml") {
			writer(props).end(data, { fields: ["account_id", "auth_method"] });
			return;
		}
		writer(props).end(orgKeyDetails(data, auth), {
			fields: ["organization", "authentication"],
		});
		return;
	}
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, {
			fields: ["login", "email", "name", "projects_limit"],
		});
		return;
	}
	writer(props).end(userDetails(data, auth), {
		fields: ["login", "email", "name", "projects_limit", "authentication"],
	});
};

type OrgKeyIdentity = { account_id: string; auth_method: "api_key_org" };

/**
 * The user, or the organization when the credential is an organization API key, which
 * `GET /users/me` refuses with 403 or 404. `GET /auth` is asked only after that refusal,
 * so user keys and OAuth still cost one request. Any other outcome rethrows the original
 * error object, which the top-level handler needs intact to recover from SSO step-up.
 */
const currentUserOrOrgKey = async (
	apiClient: NeonApiClient,
): Promise<CurrentUserInfoResponse | OrgKeyIdentity> => {
	try {
		return (await apiClient.getCurrentUserInfo()).data;
	} catch (err) {
		if (
			!isNeonApiError(err) ||
			(err.status !== 403 && err.status !== 404)
		) {
			throw err;
		}
		const details = await apiClient.getAuthDetails().then(
			({ data }) => data,
			() => undefined,
		);
		if (details?.auth_method !== "api_key_org") throw err;
		return {
			account_id: details.account_id,
			auth_method: details.auth_method,
		};
	}
};

const orgKeyDetails = (identity: OrgKeyIdentity, auth: AuthContext | null) => ({
	organization: identity.account_id,
	authentication: auth ? authenticationLabel(auth) : undefined,
});

/** Table-only view; the field names become the row labels. */
export const userDetails = (
	user: CurrentUserInfoResponse,
	auth: AuthContext | null,
) => ({
	login: user.login,
	email: user.email,
	name: [user.name, user.last_name].filter(Boolean).join(" "),
	// Accounts on organization plans can report 0, which reads as "no projects allowed"; JSON and YAML keep the value.
	projects_limit: user.projects_limit === 0 ? undefined : user.projects_limit,
	authentication: auth ? authenticationLabel(auth) : undefined,
});

export const authenticationLabel = (auth: AuthContext): string => {
	const profile = auth.profile ? ` (profile ${auth.profile})` : "";
	switch (auth.source) {
		case "stored-credentials":
			return `OAuth${profile}`;
		case "profile-api-key":
			return `API key${profile}`;
		case "api-key":
			if (auth.apiKeyFrom === "flag") return "API key (--api-key)";
			if (auth.apiKeyFrom === "env") return "API key (NEON_API_KEY)";
			return "API key";
		case "claimable":
			return "Claimable project";
	}
};
