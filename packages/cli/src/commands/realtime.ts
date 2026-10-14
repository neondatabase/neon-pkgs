import { defineConfig } from "@neon/config";
import type yargs from "yargs";
import { retryOnLock } from "../api.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { branchIdFromProps, fillSingleProject } from "../utils/enrichers.js";
import * as subscribeCommand from "./subscribe.js";

export type RealtimeEnableProps = BranchScopeProps & {
	allowedOrigins?: readonly string[];
};

/** Request Realtime provisioning or an allowed-origin update for a branch. */
export const enable = async (props: RealtimeEnableProps): Promise<void> => {
	const realtime =
		props.allowedOrigins === undefined
			? true
			: { allowedOrigins: props.allowedOrigins };
	// Give direct CLI users the same origin validation as declarative neon.ts users.
	defineConfig({ preview: { realtime } });

	const branchId = await branchIdFromProps(props);
	await retryOnLock(() =>
		props.apiClient.enableProjectBranchRealtime(
			props.projectId,
			branchId,
			props.allowedOrigins === undefined
				? {}
				: { allowed_origins: [...props.allowedOrigins] },
		),
	);
	log.info("Realtime enable requested for branch %s.", branchId);
};

/** Request Realtime deprovisioning for a branch. */
export const disable = async (props: BranchScopeProps): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	await retryOnLock(() =>
		props.apiClient.disableProjectBranchRealtime(props.projectId, branchId),
	);
	log.info("Realtime disable requested for branch %s.", branchId);
};

export const command = "realtime";
export const describe = "Manage Neon Realtime for a branch";
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 realtime <sub-command> [options]")
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			branch: {
				describe: "Branch ID or name",
				type: "string",
			},
		})
		.middleware(fillSingleProject as any)
		.command(
			"enable",
			"Enable Realtime on a branch",
			(yargs) =>
				yargs.strict().option("allowed-origin", {
					describe:
						'Allowed browser origin (repeatable). "*" allows every origin',
					type: "array",
					string: true,
				}),
			(args) =>
				enable({
					...(args as unknown as BranchScopeProps),
					...(args.allowedOrigin !== undefined
						? { allowedOrigins: args.allowedOrigin }
						: {}),
				}),
		)
		.command(
			"disable",
			"Disable Realtime on a branch",
			(yargs) => yargs.strict(),
			(args) => disable(args as unknown as BranchScopeProps),
		)
		.command(subscribeCommand as never);

export const handler = (_args: yargs.Arguments) => {
	/* Yargs requires a handler for command groups. */
};
