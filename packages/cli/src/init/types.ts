export type Editor = "Cursor" | "VS Code";

// ---------------------------------------------------------------------------
// Agent-driven state machine protocol
// ---------------------------------------------------------------------------

export type Phase = "auth" | "tooling" | "setup";

// -- NextAction discriminated union ----------------------------------------

export type NextAction =
	| AskUserAction
	| RunCommandAction
	| RunNeonInitAction
	| AgentCheckAction
	| AgentActionAction
	| CompleteAction;

export type AskUserAction = {
	type: "ask_user";
	instructions?: string;
	question: string;
	options: (string | { value: string; label: string })[];
	context?: string;
	/** Maps each option value to the next CLI invocation args, or an inline action to execute directly */
	responseMapping: Record<
		string,
		{ args: string[] } | { action: NextAction }
	>;
};

export type RunCommandAction = {
	type: "run_command";
	command: string;
	description?: string;
	timeout?: number;
	onSuccess: RunNeonInitAction;
	onFailure?: Record<string, NextAction>;
};

export type RunNeonInitAction = {
	type: "run_neon_init";
	args: string[];
};

export type AgentCheck = {
	id: string;
	description: string;
	lookFor: string[];
};

export type AgentCheckAction = {
	type: "agent_check";
	/** Step-by-step workflow for the agent describing the exact order of operations */
	instructions?: string;
	checks: AgentCheck[];
	/** Questions to ask the user — respect the phase field for ordering relative to checks */
	userPreferences?: UserPreference[];
	reportBack: RunNeonInitAction;
};

export type UserPreference = {
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
};

export type AgentStep = {
	id: string;
	description: string;
	command?: string;
};

export type AgentActionAction = {
	type: "agent_action";
	prerequisite?: string;
	steps: AgentStep[];
	onComplete: RunNeonInitAction | CompleteAction;
};

export type CompleteAction = {
	type: "complete";
	message: string;
};

// -- Phase responses -------------------------------------------------------

export type PhaseResponse = {
	phase: Phase;
	status: string;
	nextAction: NextAction;
	[key: string]: unknown;
};
