import {
	type CredentialStore,
	createCredentialStore,
} from "@neon-internals/cli-core/credential_store";
import { tryLoadKeyring } from "./keyring.js";

export const storeFor = (
	dir: string,
	env: NodeJS.ProcessEnv = process.env,
): CredentialStore =>
	createCredentialStore(dir, {
		env,
		keyring: tryLoadKeyring(),
	});
