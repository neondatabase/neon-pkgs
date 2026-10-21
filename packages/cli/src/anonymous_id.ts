import { randomUUID } from "node:crypto";
import {
	linkSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeSecretFile } from "@neon-internals/cli-core/secure_file";

import { isCi } from "./env.js";
import { log } from "./log.js";
import { isEexist } from "./refresh_lock.js";

export const ANONYMOUS_ID_FILE = "anonymous_id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const readStored = (path: string): string | undefined => {
	try {
		const stored = readFileSync(path, "utf8").trim();
		return UUID.test(stored) ? stored : undefined;
	} catch {
		return undefined;
	}
};

/**
 * Names this installation in analytics before sign-in. Commands that know the user send it
 * alongside `userId`, so earlier events can be linked to the account.
 *
 * Not stored in CI, where the config directory doesn't outlive the run and every run would
 * mint a new installation. Call only once analytics is known to be enabled.
 */
export const getOrCreateAnonymousId = (
	configDir: string,
): string | undefined => {
	if (isCi()) {
		return undefined;
	}
	const path = join(configDir, ANONYMOUS_ID_FILE);
	try {
		const stored = readStored(path);
		if (stored) {
			return stored;
		}
		mkdirSync(configDir, { recursive: true });
		const id = randomUUID();
		// Parallel first runs (an agent firing several commands at once) all find no file.
		// Linking a complete temporary file into place fails for all but one, and the losers
		// adopt the winner's id instead of each keeping their own.
		const temporary = `${path}.${id}.tmp`;
		writeFileSync(temporary, `${id}\n`, { mode: 0o600, flag: "wx" });
		try {
			linkSync(temporary, path);
			return id;
		} catch (err) {
			if (!isEexist(err)) {
				throw err;
			}
			const winner = readStored(path);
			if (winner) {
				return winner;
			}
			// The file exists but holds no UUID: replace it.
			writeSecretFile(path, `${id}\n`);
			return id;
		} finally {
			try {
				unlinkSync(temporary);
			} catch {
				// Already gone.
			}
		}
	} catch (err) {
		// Telemetry must never fail a command.
		log.debug("Could not store the anonymous analytics id: %s", err);
		return undefined;
	}
};
