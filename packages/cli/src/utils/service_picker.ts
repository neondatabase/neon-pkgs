import prompts from "prompts";
import { NEON_SERVICES, type NeonService } from "../config_template.js";

/**
 * The picker's rows, in {@link NEON_SERVICES} order. Titles use the product names from the
 * CLI's README ("Managed Better Auth", "Object Storage") rather than the `neon.ts` field
 * names, since this is the list a user reads before they've seen a policy.
 */
const CHOICES: { value: NeonService; title: string; description: string }[] = [
	{
		value: "auth",
		title: "Managed Better Auth",
		description: "Users, sessions, and OAuth providers managed by Neon",
	},
	{
		value: "ai-gateway",
		title: "AI Gateway",
		description:
			"One OpenAI-compatible endpoint; provisioning needs a paid plan",
	},
	{
		value: "functions",
		title: "Functions",
		description:
			"Scaffolds hello.ts and declares it as a deployable function",
	},
	{
		value: "storage",
		title: "Object Storage",
		description: "A branchable private bucket named assets",
	},
];

/**
 * Ask which services the scaffolded `neon.ts` should declare. Selecting nothing is a real
 * answer — it yields the bare starter policy — so an empty list returns empty rather than
 * re-prompting. Aborting (Ctrl-C) exits 1, matching the prompts in `link`.
 *
 * Callers guard the TTY themselves (see `initCmd`); this function assumes it may prompt.
 */
export const pickServicesInteractively = async (): Promise<NeonService[]> => {
	const { services } = await prompts({
		onState: (state: { aborted: boolean }) => {
			if (state.aborted) {
				// Restore the cursor prompts hid, then exit — otherwise the terminal is
				// left without one for the rest of the session.
				process.stdout.write("\x1B[?25h");
				process.stdout.write("\n");
				process.exit(1);
			}
		},
		type: "multiselect",
		name: "services",
		message:
			"Which Neon services should neon.ts declare? (space to toggle, enter to confirm)",
		instructions: false,
		choices: CHOICES.map((choice) => ({
			value: choice.value,
			title: choice.title,
			description: choice.description,
		})),
	});

	if (!Array.isArray(services)) {
		throw new Error("Aborted: no services selected.");
	}
	// Order by NEON_SERVICES rather than selection order so the rendered neon.ts is
	// independent of the order the rows were toggled in.
	return NEON_SERVICES.filter((service) => services.includes(service));
};
