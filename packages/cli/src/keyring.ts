import { createRequire } from "node:module";
import type { KeyringBackend } from "@neon-internals/cli-core/credential_store";

type NapiEntry = {
	getPassword(): string | null;
	setPassword(password: string): void;
	deletePassword(): boolean;
};

type NapiKeyring = {
	Entry: new (service: string, account: string) => NapiEntry;
};

const isPackaged = (): boolean =>
	(process as { pkg?: unknown }).pkg !== undefined;

const isMissingItem = (err: unknown): boolean => {
	const message = err instanceof Error ? err.message : String(err);
	return /no matching entry|not found|password not found/i.test(message);
};

/**
 * A literal addon specifier makes the standalone bundle require a native module
 * that packaged binaries cannot load.
 */
export const tryLoadKeyring = (): KeyringBackend | null => {
	if (isPackaged()) return null;
	try {
		const require = createRequire(import.meta.url);
		const spec = ["@napi-rs", "keyring"].join("/");
		const loaded = require(spec) as NapiKeyring;
		const { Entry } = loaded;
		return {
			get(service, account) {
				try {
					return new Entry(service, account).getPassword();
				} catch (err) {
					if (isMissingItem(err)) return null;
					throw err;
				}
			},
			set(service, account, password) {
				new Entry(service, account).setPassword(password);
			},
			delete(service, account) {
				try {
					return new Entry(service, account).deletePassword();
				} catch (err) {
					if (isMissingItem(err)) return false;
					throw err;
				}
			},
		};
	} catch {
		return null;
	}
};
