import type { CurrentUserInfoResponse } from "@neon/sdk";
import type yargs from "yargs";

import { type AuthContext, getAuthContext } from "../auth_context.js";
import type { CommonProps } from "../types.js";
import { writer } from "../writer.js";

export const command = "me";
export const describe = "Show current user";
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
	const { data } = await props.apiClient.getCurrentUserInfo();
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, {
			fields: ["login", "email", "name", "projects_limit"],
		});
		return;
	}
	writer(props).end(userDetails(data, getAuthContext()), {
		fields: ["login", "email", "name", "projects_limit", "authentication"],
	});
};

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
