import { isAuthenticated } from "../auth.js";
import { neonctlCmd } from "../neonctl.js";
import type { PhaseResponse } from "../types.js";

function getSignupUrl(): string {
	return process.env.NEON_API_HOST
		? `${new URL(process.env.NEON_API_HOST).origin}/signup`
		: "https://console.neon.tech/signup";
}

function getSignupCommands(): Record<string, string> {
	const url = getSignupUrl();
	return {
		darwin: `open ${url}`,
		linux: `xdg-open ${url}`,
		win32: `start ${url}`,
	};
}

export interface AuthPhaseOptions {
	agent?: string;
	method?: "existing" | "new";
	verify?: boolean;
}

export async function handleAuthPhase(
	options: AuthPhaseOptions,
): Promise<PhaseResponse> {
	const agentArgs = options.agent
		? ["--agent", options.agent, "--json"]
		: ["--json"];

	// --verify: just check if credentials exist
	if (options.verify) {
		const authed = await isAuthenticated();
		if (authed) {
			// Continue the flow immediately — don't use "complete" which
			// causes agents to stop and get distracted by neonctl output.
			return {
				phase: "auth",
				status: "verified",
				nextAction: {
					type: "run_neon_init",
					args: agentArgs,
				},
			};
		}
		return {
			phase: "auth",
			status: "not_authenticated",
			nextAction: {
				type: "run_neon_init",
				args: ["auth", "--json"],
			},
		};
	}

	// Check if already authenticated
	const authed = await isAuthenticated();
	if (authed) {
		return {
			phase: "auth",
			status: "verified",
			nextAction: {
				type: "run_neon_init",
				args: agentArgs,
			},
		};
	}

	// --method new: guide through signup
	if (options.method === "new") {
		const openCmd =
			getSignupCommands()[process.platform] ?? getSignupCommands().linux;
		return {
			phase: "auth",
			status: "in_progress",
			nextAction: {
				type: "agent_action",
				steps: [
					{
						id: "open_signup",
						description:
							"Open the Neon sign-up page in the user's browser",
						command: openCmd,
					},
					{
						id: "wait_for_signup",
						description:
							"Tell the user: 'I've opened the Neon sign-up page. Create your account and verify your email, then let me know when you're ready.'",
					},
				],
				onComplete: {
					type: "run_neon_init",
					args: ["auth", "--json", "--method", "existing"],
				},
			},
		};
	}

	// --method existing: run OAuth flow
	if (options.method === "existing") {
		return {
			phase: "auth",
			status: "in_progress",
			nextAction: {
				type: "run_command",
				command: `${neonctlCmd()} auth`,
				description:
					"This will open your browser for Neon OAuth sign-in.",
				timeout: 120000,
				onSuccess: {
					type: "run_neon_init",
					args: ["auth", "--json", "--verify"],
				},
				onFailure: {
					"2": {
						type: "ask_user",
						question:
							"The sign-in timed out. Did you complete the sign-in in your browser?",
						options: ["yes_retry", "need_help"],
						responseMapping: {
							yes_retry: {
								args: [
									"auth",
									"--json",
									"--method",
									"existing",
								],
							},
							need_help: {
								args: ["auth", "--json", "--method", "new"],
							},
						},
					},
					other: {
						type: "run_neon_init",
						args: ["auth", "--json"],
					},
				},
			},
		};
	}

	// No method specified: ask the user, then launch OAuth directly for
	// "existing account" without an intermediate CLI round-trip.
	const openCmd =
		getSignupCommands()[process.platform] ?? getSignupCommands().linux;
	return {
		phase: "auth",
		status: "required",
		nextAction: {
			type: "ask_user",
			question:
				"Do you have an existing Neon account, or do you need to create one?",
			options: [
				{
					value: "existing_account",
					label: "I have an existing Neon account",
				},
				{
					value: "new_account",
					label: "I need to create a new account",
				},
			],
			context:
				"Neon is a serverless Postgres provider. A free account is required to continue.",
			responseMapping: {
				existing_account: {
					action: {
						type: "run_command",
						command: `${neonctlCmd()} auth`,
						description:
							"This will open your browser for Neon OAuth sign-in.",
						timeout: 120000,
						onSuccess: {
							type: "run_neon_init",
							args: ["auth", "--json", "--verify"],
						},
						onFailure: {
							"2": {
								type: "ask_user",
								question:
									"The sign-in timed out. Did you complete the sign-in in your browser?",
								options: ["yes_retry", "need_help"],
								responseMapping: {
									yes_retry: {
										args: [
											"auth",
											"--json",
											"--method",
											"existing",
										],
									},
									need_help: {
										args: [
											"auth",
											"--json",
											"--method",
											"new",
										],
									},
								},
							},
							other: {
								type: "run_neon_init",
								args: ["auth", "--json"],
							},
						},
					},
				},
				new_account: {
					action: {
						type: "agent_action",
						steps: [
							{
								id: "open_signup",
								description:
									"Open the Neon sign-up page in the user's browser",
								command: openCmd,
							},
							{
								id: "wait_for_signup",
								description:
									"Tell the user: 'I've opened the Neon sign-up page. Create your account and verify your email, then let me know when you're ready.'",
							},
						],
						onComplete: {
							type: "run_neon_init",
							args: ["auth", "--json", "--method", "existing"],
						},
					},
				},
			},
		},
	};
}
