import { defineConfig } from "@neon/config";
import type yargs from "yargs";
import { retryOnLock } from "../api.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { getCliName } from "../utils/cli_name.js";
import { branchIdFromProps, fillSingleProject } from "../utils/enrichers.js";
import {
	builder as subscribeBuilder,
	handler as subscribeHandler,
} from "./subscribe.js";

export type RealtimeEnableProps = BranchScopeProps & {
	allowedOrigins?: readonly string[];
	wait: boolean;
};

export type RealtimeRotateSecretProps = BranchScopeProps & {
	wait: boolean;
};

const POLL_INTERVAL_MS =
	Number(process.env.NEON_REALTIME_POLL_INTERVAL_MS) || 1_000;
const POLL_TIMEOUT_MS =
	Number(process.env.NEON_REALTIME_POLL_TIMEOUT_MS) || 60_000;

/** Enable Realtime or update its allowed origins, waiting until the branch applies it. */
export const enable = async (props: RealtimeEnableProps): Promise<void> => {
	const realtime =
		props.allowedOrigins === undefined
			? true
			: { allowedOrigins: props.allowedOrigins };
	// Give direct CLI users the same origin validation as declarative neon.ts users.
	defineConfig({ preview: { realtime } });

	const branchId = await branchIdFromProps(props);
	const [{ fromSdkError, getNeonClient }, { NeonWaitTimeoutError }] =
		await Promise.all([import("../neon_client.js"), import("@neon/sdk")]);
	await getNeonClient(props)
		.realtime.enable(
			{
				projectId: props.projectId,
				branchId,
				...(props.allowedOrigins === undefined
					? {}
					: { allowed_origins: [...props.allowedOrigins] }),
			},
			{
				waitForReadiness: props.wait,
				wait: {
					pollIntervalMs: POLL_INTERVAL_MS,
					timeoutMs: POLL_TIMEOUT_MS,
				},
			},
		)
		.catch((error: unknown) => {
			if (error instanceof NeonWaitTimeoutError) {
				throw new Error(
					`Timed out waiting for Realtime on branch ${branchId}. The change was requested and may still be in progress; run the command again to keep waiting.`,
				);
			}
			throw fromSdkError(error, props.apiHost);
		});
	if (props.wait) {
		log.info("Realtime is enabled on branch %s.", branchId);
	} else {
		log.info("Realtime enable requested for branch %s.", branchId);
	}
};

/** Request Realtime deprovisioning for a branch. */
export const disable = async (props: BranchScopeProps): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	await retryOnLock(() =>
		props.apiClient.disableProjectBranchRealtime(props.projectId, branchId),
	);
	log.info("Realtime disable requested for branch %s.", branchId);
};

/** Request replacement of a branch's Realtime shared secret. */
export const rotateSecret = async (
	props: RealtimeRotateSecretProps,
): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	await retryOnLock(() =>
		props.apiClient.rotateProjectBranchRealtimeSecret(
			props.projectId,
			branchId,
		),
	);
	log.info("Realtime secret rotation requested for branch %s.", branchId);
	if (!props.wait) return;

	const deadline = Date.now() + POLL_TIMEOUT_MS;
	do {
		const { data } = await props.apiClient.getProjectBranchRealtime(
			props.projectId,
			branchId,
		);
		if (!data.pending) {
			log.info(
				"Realtime secret rotation completed for branch %s.",
				branchId,
			);
			log.info(
				"Run %s env pull --service realtime to update NEON_REALTIME_SECRET.",
				getCliName(),
			);
			return;
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) break;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remainingMs)),
		);
	} while (Date.now() < deadline);

	throw new Error(
		`Timed out waiting for Realtime secret rotation on branch ${branchId}. It may still be in progress.`,
	);
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
				yargs.strict().options({
					"allowed-origin": {
						describe:
							'Allowed browser origin (repeatable). "*" allows every origin',
						type: "array",
						string: true,
					},
					wait: {
						describe:
							"Wait until Realtime is enabled on the branch",
						type: "boolean",
						default: true,
					},
				}),
			(args) =>
				enable({
					...(args as unknown as BranchScopeProps & {
						wait: boolean;
					}),
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
		.command(
			"rotate-secret",
			"Replace a branch's Realtime shared secret",
			(yargs) =>
				yargs.strict().option("wait", {
					describe: "Wait for the Realtime secret rotation to finish",
					type: "boolean",
					default: true,
				}),
			(args) =>
				rotateSecret(args as unknown as RealtimeRotateSecretProps),
		)
		.command(
			"subscribe <query>",
			"Subscribe to a live SQL query with Neon Realtime",
			subscribeBuilder,
			subscribeHandler,
		);

export const handler = (_args: yargs.Arguments) => {
	/* Yargs requires a handler for command groups. */
};
