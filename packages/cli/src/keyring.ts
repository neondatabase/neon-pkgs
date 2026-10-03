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

// Windows Credential Manager accepts at most 2560 bytes, or 1280 UTF-16 code units.
const WINDOWS_CREDENTIAL_MAX_CODE_UNITS = 1280;

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
			...(process.platform === "win32"
				? { maxPasswordCodeUnits: WINDOWS_CREDENTIAL_MAX_CODE_UNITS }
				: {}),
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
