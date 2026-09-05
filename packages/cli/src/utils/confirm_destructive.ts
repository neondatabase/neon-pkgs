import prompts, { type InitialReturnValue } from "prompts";

import { isCi } from "../env.js";

export const yesOption = {
	alias: "y",
	type: "boolean" as const,
	default: false,
	describe: "Skip the confirmation prompt",
};

export const isMachineOutput = (
	output: "yaml" | "json" | "table",
): output is "yaml" | "json" => output === "json" || output === "yaml";

export const namedResource = (
	id: string,
	name: string | null | undefined,
): string => (name ? `${id} (${name})` : id);

export type ConfirmDestructiveDeps = {
	isCi: () => boolean;
	stdinIsTty: () => boolean;
	confirm: (message: string) => Promise<boolean>;
};

const restoreCursorOnAbort = (state: {
	value: InitialReturnValue;
	aborted: boolean;
	exited: boolean;
}) => {
	if (state.aborted) {
		// prompts hides the cursor; leaving it hidden after Ctrl-C looks like a hung terminal
		process.stdout.write("\x1B[?25h");
		process.stdout.write("\n");
		process.exit(1);
	}
};

const defaultConfirm = async (message: string): Promise<boolean> => {
	const { proceed } = await prompts({
		onState: restoreCursorOnAbort,
		type: "confirm",
		name: "proceed",
		message,
		initial: false,
	});
	return Boolean(proceed);
};

const defaultDeps: ConfirmDestructiveDeps = {
	isCi,
	stdinIsTty: () => Boolean(process.stdin.isTTY),
	confirm: defaultConfirm,
};

export const confirmDestructive = async (
	options: {
		yes: boolean;
		noun: string;
		message: string;
		forceYes?: boolean;
	},
	deps: ConfirmDestructiveDeps = defaultDeps,
): Promise<void> => {
	if (options.yes) {
		return;
	}
	if (options.forceYes || deps.isCi() || !deps.stdinIsTty()) {
		throw new Error(
			`Deleting a ${options.noun} requires confirmation. Re-run interactively or pass --yes.`,
		);
	}
	const proceed = await deps.confirm(options.message);
	if (!proceed) {
		throw new Error(`Cancelled — ${options.noun} was not deleted.`);
	}
};
