import type yargs from "yargs";

import { projectsListBuilder, projectsListHandler } from "./projects.js";

export const command = "list";
export const describe = "List projects (alias of `projects list`)";
export const builder = (argv: yargs.Argv) =>
	projectsListBuilder(argv.usage("$0 list [options]"));
export const handler = projectsListHandler;
