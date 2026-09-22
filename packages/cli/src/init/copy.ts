import { getCliName } from "../utils/cli_name.js";

export const INIT_SUBTITLE =
	"Set up coding agents and this directory for Neon.";

export const MODE_MESSAGE = "How would you like to set up Neon?";
export const MODE_RECOMMENDED_TITLE = "Recommended setup";
export const MODE_RECOMMENDED_DESCRIPTION =
	"Set up detected agents, link a project, and add a default neon.ts in this directory.";
export const MODE_CUSTOM_TITLE = "Custom setup";
export const MODE_CUSTOM_DESCRIPTION =
	"Choose agent tooling, project setup, and the services declared in neon.ts.";

export const AGENT_SETUP_MESSAGE =
	"How should Neon be added to your coding agents?";
export const AGENT_SETUP_PLUGIN_TITLE = "Neon plugin";
export const AGENT_SETUP_PLUGIN_DESCRIPTION =
	"Install Neon skills and the MCP server together.";
export const AGENT_SETUP_SKILLS_TITLE = "Skills and MCP separately";
export const AGENT_SETUP_SKILLS_DESCRIPTION =
	"Install Neon skills and configure the MCP server as separate steps.";
export const AGENT_SETUP_SKIP_TITLE = "Skip agent setup";
export const AGENT_SETUP_SKIP_DESCRIPTION =
	"Continue to project setup without changing agent configuration.";

export const AGENT_PICKER_MESSAGE =
	"Which coding agents should receive Neon tooling? (space to toggle, enter to confirm)";
export const AGENT_DETECTED_DESCRIPTION =
	"Detected on this machine or in this directory.";
export const AGENT_OTHER_DESCRIPTION = "Install for this agent.";

export const SKILLS_PICKER_MESSAGE =
	"Which Neon skills should be installed? (space to toggle, enter to confirm)";

export const MCP_SCOPE_MESSAGE =
	"Where should the Neon MCP server be configured?";
export const MCP_SCOPE_GLOBAL_TITLE = "User configuration";
export const MCP_SCOPE_GLOBAL_DESCRIPTION =
	"Make the MCP server available across projects.";
export const MCP_SCOPE_PROJECT_TITLE = "This directory";
export const MCP_SCOPE_PROJECT_DESCRIPTION =
	"Add the MCP server to this project's agent configuration.";

export const MCP_AUTH_MESSAGE =
	"How should the MCP server authenticate to Neon?";
export const MCP_AUTH_OAUTH_TITLE = "Sign in from the coding agent";
export const MCP_AUTH_OAUTH_DESCRIPTION =
	"Configure OAuth. The agent asks you to sign in on first use.";
export const MCP_AUTH_API_KEY_TITLE = "Use a Neon API key";
export const MCP_AUTH_API_KEY_DESCRIPTION =
	"Reuse an existing MCP key or create a key after CLI authentication.";

export const mcpPinMessage = (projectId: string): string =>
	`Limit MCP tools to the linked project ${projectId}?`;

export const MCP_PIN_MINT_NOTE =
	"The new API key will also be limited to this project.";

export const CLAIMABLE_MCP_API_KEY =
	"Claimable project setup cannot create an account API key for MCP. Use --mcp-auth oauth.";
export const CLAIMABLE_NO_LINK =
	"--project-setup claimable cannot be combined with --no-link.";
export const CLAIMABLE_ACCOUNT_FLAGS =
	"--project-setup claimable cannot be combined with --org-id, --project-id, --project-name, --region-id, or --branch.";

export const PROJECT_SETUP_MESSAGE =
	"How would you like to get a Neon project?";
export const PROJECT_SETUP_LINK_TITLE = "Sign in to Neon";
export const PROJECT_SETUP_LINK_DESCRIPTION =
	"Link an existing project or create a new one in your account.";
export const PROJECT_SETUP_CLAIMABLE_TITLE = "Create a claimable project";
export const PROJECT_SETUP_CLAIMABLE_DESCRIPTION =
	"Start without an account. The project expires in 72 hours unless claimed.";

export const CONFIG_CONFIRM_HINT =
	"Declare Neon services in a file you can review before deploying.";
export const CONFIG_CONFIRM_MESSAGE = "Create neon.ts in this directory?";

export const SERVICES_HINT =
	"Postgres is included in every Neon project. Leave all services unselected for the default neon.ts.";
export const SERVICES_MESSAGE =
	"Which services should neon.ts declare? (space to toggle, enter to confirm)";

export const PACKAGE_MANAGER_MESSAGE =
	"Which package manager should install the Neon dependencies?";

export const NO_AGENTS_FALLBACK_STATUS =
	"No coding agents detected. Installing the default Neon skills for Cursor and Codex at user scope.";

export const YES_SELECTS_RECOMMENDED =
	"--yes selects Recommended setup. Omit --yes to use --mode custom, and pass flags for any choices you want to skip.";

export const TEMPLATE_UNSUPPORTED_FLAGS =
	"--template cannot be combined with --mode, --project-setup, --package-manager, --skill, or MCP flags. After scaffolding, skip agent setup with --agent-setup skip.";

export const NON_TTY_LINK_NEEDS_AUTH =
	"No interactive terminal. Sign in with `neon auth`, then re-run, or pass --project-setup claimable.";

export const HEADING_COMPLETE = "Neon setup complete.";
export const HEADING_PENDING = "Neon setup needs a next step.";
export const HEADING_FAILED = "Neon setup failed.";
export const HEADING_CANCELLED = "Neon setup cancelled.";

export const CANCELLED_BODY =
	"Changes completed before cancellation were kept.";

export const PROGRESS = {
	plugins: "Installing the Neon plugin...",
	skills: "Installing Neon skills...",
	mcp: "Configuring the Neon MCP server...",
	auth: "Signing in to Neon...",
	link: "Linking a Neon project...",
	claim: "Creating a claimable project...",
	config: "Creating neon.ts...",
	install: (pm: string): string =>
		`Installing Neon dependencies with ${pm}...`,
	env: "Pulling Neon environment variables...",
} as const;

export const unattendedUnauthedNext = (): string[] => [
	"Link a project with a Neon account and an authenticated CLI.",
	"Sign up: https://neon.com/signup",
	`${getCliName()} auth`,
	`${getCliName()} link`,
	"",
	"Or create a claimable project without an account. It expires in 72 hours unless claimed.",
	`${getCliName()} claim create`,
];

export const skippedLinkNext = (): string[] => [
	"To connect this directory to a Neon project:",
	`${getCliName()} link`,
];

export const extraServicesNext = (): string[] => [
	"Review neon.ts and confirm the linked project and branch before deploying.",
	"Preview the changes:",
	`${getCliName()} config plan`,
	"",
	"Deploy when the changes and target are correct:",
	`${getCliName()} deploy`,
	"",
	"Refresh local environment variables after deployment:",
	`${getCliName()} env pull`,
];

export const existingConfigNext = (): string[] => [
	"The existing Neon config was preserved. Refresh environment variables when its declared services are available:",
	`${getCliName()} env pull`,
];

export const claimableNext = (expiresAt: string): string[] => [
	`This project expires at ${expiresAt}.`,
	"To keep it, open the claim flow and sign in to Neon:",
	`${getCliName()} claim accept`,
];

export const claimableThenServicesNext = (expiresAt: string): string[] => [
	...claimableNext(expiresAt),
	"",
	"After claiming the project, review neon.ts and preview the changes:",
	`${getCliName()} config plan`,
	"",
	"Deploy when the changes and target are correct:",
	`${getCliName()} deploy`,
	"",
	"Refresh local environment variables:",
	`${getCliName()} env pull`,
];

export const installFailedNext = (
	command: string,
): { heading: string; body: string; next: string[] } => ({
	heading: HEADING_FAILED,
	body: "Could not install the Neon dependencies.",
	next: ["Install the dependencies, then run neon init again:", command],
});

export const envPullFailedNext = (): {
	heading: string;
	body: string;
	next: string[];
} => ({
	heading: HEADING_FAILED,
	body: "The project is linked, but its environment variables could not be pulled.",
	next: ["Resolve the error above, then retry:", `${getCliName()} env pull`],
});

export type InitOutcomeKind = "success" | "pending" | "error" | "aborted";

export const headingForOutcome = (outcome: InitOutcomeKind): string => {
	switch (outcome) {
		case "success":
			return HEADING_COMPLETE;
		case "pending":
			return HEADING_PENDING;
		case "error":
			return HEADING_FAILED;
		case "aborted":
			return HEADING_CANCELLED;
		default: {
			const _exhaustive: never = outcome;
			return _exhaustive;
		}
	}
};
