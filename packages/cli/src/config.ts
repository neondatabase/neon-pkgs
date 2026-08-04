import { existsSync, mkdirSync } from "node:fs";
import type yargs from "yargs";

import { isCi } from "./env.js";

export {
	CREDENTIALS_FILE,
	credentialsPath,
	defaultDir,
	isInsideConfigDir,
	isOwnedCredentialPath,
} from "./_shared/paths.js";

export const ensureConfigDir = ({
	"config-dir": configDirArg,
	"force-auth": forceAuth,
}: yargs.Arguments<{ "config-dir": string }>) => {
	if (!existsSync(configDirArg) && (!isCi() || forceAuth)) {
		mkdirSync(configDirArg, { recursive: true });
	}
};
