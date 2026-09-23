import prompts from "prompts";
import { CONFIG_INIT_SERVICES } from "../config_template.js";
import type { NeonService } from "../neon_services.js";

/**
 * Re-select Postgres after each render. `prompts` lets space unselect a selected
 * row even when `disabled` is set, and `disabled` also strikethroughs the title.
 */
export const keepPostgresSelected = (prompt: unknown): void => {
	if (typeof prompt !== "object" || prompt === null || !("value" in prompt)) {
		return;
	}
	const rows = prompt.value;
	if (!Array.isArray(rows)) {
		return;
	}
	for (const row of rows) {
		if (!isChoiceRow(row) || row.value !== "postgres") {
			continue;
		}
		row.selected = true;
	}
};

const isChoiceRow = (
	row: unknown,
): row is { value: unknown; selected: boolean } =>
	typeof row === "object" &&
	row !== null &&
	"value" in row &&
	"selected" in row;

export const POSTGRES_SERVICE_CHOICE = {
	value: "postgres",
	title: "Postgres (always included)",
	description: "Every Neon project includes a Postgres database.",
	selected: true,
};

/**
 * The picker's rows, in {@link CONFIG_INIT_SERVICES} order after the locked Postgres
 * row. Titles use the product names from the CLI's README ("Managed Better Auth",
 * "Object Storage") rather than the `neon.ts` field names, since this is the list a
 * user reads before they've seen a policy.
 */
const CHOICES: { value: NeonService; title: string; description: string }[] = [
	{
		value: "auth",
		title: "Managed Better Auth",
		description:
			"Authentication with users and sessions stored in Postgres.",
	},
	{
		value: "data-api",
		title: "Data API",
		description:
			"PostgREST-compatible HTTP API. Also declares Auth; the default provider needs it.",
	},
	{
		value: "functions",
		title: "Functions",
		description:
			"Long-running, without timeouts, and closer to your database.",
	},
	{
		value: "object-storage",
		title: "Object Storage",
		description:
			"S3-compatible blob storage that branches with your projects.",
	},
	{
		value: "ai-gateway",
		title: "AI Gateway",
		description:
			"All models, one API, one bill. Powered by Databricks. Not available on the Neon free plan.",
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
	const question = {
		onState: (state: { aborted: boolean }) => {
			if (state.aborted) {
				// Restore the cursor prompts hid, then exit — otherwise the terminal is
				// left without one for the rest of the session.
				process.stdout.write("\x1B[?25h");
				process.stdout.write("\n");
				process.exit(1);
			}
		},
		onRender() {
			keepPostgresSelected(this);
		},
		type: "multiselect" as const,
		name: "services" as const,
		message:
			"Which Neon services should neon.ts declare? (space to toggle, enter to confirm)",
		instructions: false,
		// prompts starts the highlight here so space toggles Auth, not locked Postgres.
		cursor: 1,
		choices: [
			POSTGRES_SERVICE_CHOICE,
			...CHOICES.map((choice) => ({
				value: choice.value,
				title: choice.title,
				description: choice.description,
			})),
		],
	};
	const { services } = await prompts(question);

	if (!Array.isArray(services)) {
		throw new Error("Aborted: no services selected.");
	}
	// Order canonically rather than by selection order so the rendered neon.ts is
	// independent of the order the rows were toggled in.
	return CONFIG_INIT_SERVICES.filter((service) => services.includes(service));
};
