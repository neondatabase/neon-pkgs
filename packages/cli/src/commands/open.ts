import openBrowser from "open";
import type yargs from "yargs";
import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import { getCliName } from "../utils/cli_name.js";

type OpenProps = CommonProps & {
	projectId?: string;
};

export const command = "open";
export const describe = "Open the linked project in the Neon Console";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 open [options]")
		.option("project-id", {
			describe: "Project ID (defaults to the project linked in .neon)",
			type: "string",
		})
		.example("$0 open", describe);

export const projectConsoleUrl = (projectId: string): string =>
	`https://console.neon.tech/app/projects/${encodeURIComponent(projectId)}`;

export const handler = async (props: OpenProps) => {
	if (!props.projectId) {
		throw new Error(
			`No Neon project linked. Run \`${getCliName()} link\` to link this directory to a project.`,
		);
	}

	const url = projectConsoleUrl(props.projectId);
	log.info("Opening %s in your browser.", url);

	const subprocess = await openBrowser(url);
	await new Promise<void>((resolve, reject) => {
		subprocess.once("spawn", resolve);
		subprocess.once("error", (error) => {
			reject(
				new Error(
					`Failed to open the Neon Console in your browser. Open ${url} manually. ${error.message}`,
				),
			);
		});
	});
};
