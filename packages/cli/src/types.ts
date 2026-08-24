import type { TokenEndpointResponse } from "openid-client";
import type { NeonApiClient } from "./api.js";

export type CommonProps = {
	apiClient: NeonApiClient;
	apiKey: string;
	apiHost: string;
	output: "yaml" | "json" | "table";
	contextFile: string;
};

export type ProjectScopeProps = CommonProps & {
	projectId: string;
};

export type OrgScopeProps = CommonProps & {
	orgId: string;
};

export type IdOrNameProps = {
	id: string;
};

export type BranchScopeProps = ProjectScopeProps &
	(
		| {
				branch: string;
		  }
		| IdOrNameProps
	);

export type ExtendedTokenSet = TokenEndpointResponse & {
	expires_at: number;
};

/**
 * A branch option in an `--agent` `needs_branch` response. Emitted by both `link`
 * and `checkout`, so it lives here to keep the two commands' contract identical.
 */
export type AgentBranchOption = { id: string; name: string; default: boolean };
