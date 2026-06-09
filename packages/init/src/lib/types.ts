export type Editor =
	| "Cursor"
	| "VS Code"
	| "Claude CLI"
	| "Claude Desktop"
	| "Codex"
	| "OpenCode"
	| "Antigravity"
	| "Cline"
	| "Cline CLI"
	| "Gemini CLI"
	| "GitHub Copilot CLI"
	| "Goose"
	| "MCPorter"
	| "Zed";

export type InstallStatus = "success" | "failed";

// ---------------------------------------------------------------------------
// v1 types (kept for backward compatibility)
// ---------------------------------------------------------------------------

export interface InitResult {
	success: boolean;
	auth: boolean;
	authRequired?: boolean;
	authInstructions?: string;
	agentInstructions?: string;
	editors: {
		editor: Editor;
		status: InstallStatus;
		type: "mcp" | "extension";
	}[];
	skills: {
		installed: boolean;
		gettingStarted: string | null;
		references: Record<string, string>;
	};
	neonctl: {
		authenticated: boolean;
		commands: {
			listOrgs: string;
			listProjects: string;
			createProject: string;
			getConnectionString: string;
		};
	};
	mcpServer: {
		configured: boolean;
		requiresRestart: boolean;
	};
}

// ---------------------------------------------------------------------------
// v2 types – agent-driven state machine protocol
// ---------------------------------------------------------------------------

export type Phase =
	| "auth"
	| "tooling"
	| "setup"
	| "db"
	| "neon_auth"
	| "migrations";

// -- NextAction discriminated union ----------------------------------------

export type NextAction =
	| AskUserAction
	| RunCommandAction
	| RunNeonInitAction
	| AgentCheckAction
	| AgentActionAction
	| RestartRequiredAction
	| CompleteAction;

export interface AskUserAction {
	type: "ask_user";
	question: string;
	options: (string | { value: string; label: string })[];
	context?: string;
	/** Maps each option value to the next CLI invocation args, or an inline action to execute directly */
	responseMapping: Record<
		string,
		{ args: string[] } | { action: NextAction }
	>;
}

export interface RunCommandAction {
	type: "run_command";
	command: string;
	description?: string;
	timeout?: number;
	onSuccess: RunNeonInitAction;
	onFailure?: Record<string, NextAction>;
}

export interface RunNeonInitAction {
	type: "run_neon_init";
	args: string[];
}

export interface AgentCheck {
	id: string;
	description: string;
	lookFor: string[];
}

export interface AgentCheckAction {
	type: "agent_check";
	/** Step-by-step workflow for the agent describing the exact order of operations */
	instructions?: string;
	checks: AgentCheck[];
	/** Questions to ask the user — respect the phase field for ordering relative to checks */
	userPreferences?: UserPreference[];
	reportBack: RunNeonInitAction;
}

export interface UserPreference {
	id: string;
	question: string;
	options: (string | { value: string; label: string })[];
	context?: string;
	default?: string;
	/** Only present this preference if another preference was answered with the specified value */
	condition?: {
		preferenceId: string;
		equals: string;
	};
	/** When to ask this preference relative to the inspection checks */
	phase?: "before_checks" | "after_checks";
	/** Preferences with the same group should be presented together as a single form */
	group?: string;
}

export interface AgentStep {
	id: string;
	description: string;
	command?: string;
}

export interface AgentActionAction {
	type: "agent_action";
	prerequisite?: string;
	steps: AgentStep[];
	onComplete: RunNeonInitAction | CompleteAction;
}

export interface RestartRequiredAction {
	type: "restart_required";
	reason: string;
	resumeCommand: string;
}

export interface CompleteAction {
	type: "complete";
	message: string;
}

// -- Phase responses -------------------------------------------------------

export interface PhaseResponse {
	phase: Phase;
	status: string;
	nextAction: NextAction;
	[key: string]: unknown;
}

// -- Status response (read-only, no nextAction) ----------------------------

export interface StatusResponse {
	auth: {
		authenticated: boolean;
		user?: string;
	};
	tooling: {
		mcpServer: { configured: boolean | null; location?: string };
		skills: { installed: boolean };
		extension?: { installed: boolean; editor: string } | null;
	};
	project: {
		databaseUrl: boolean;
	};
	migrations: {
		tool: string | null;
		hasMigrations: boolean;
	};
	recommendations: { priority: string; message: string; command: string }[];
}
