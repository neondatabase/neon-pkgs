import type yargs from "yargs";

import {
	projectsListBuilder,
	projectsListHandler,
	setProjectIdForAnalytics,
} from "./projects.js";

export const command = "list";
export const describe = "List projects (alias of `projects list`)";
export const builder = (argv: yargs.Argv) =>
	projectsListBuilder(
		argv.usage("$0 list [options]").middleware(setProjectIdForAnalytics),
	);
export const handler = projectsListHandler;
