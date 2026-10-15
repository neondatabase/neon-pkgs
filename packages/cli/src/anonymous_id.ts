import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSecretFile } from "@neon-internals/cli-core/secure_file";

import { isCi } from "./env.js";
import { log } from "./log.js";

export const ANONYMOUS_ID_FILE = "anonymous_id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A random id, stored in the config directory, that names this installation in analytics
 * before anyone has signed in. Once a command knows the user, it sends the id alongside the
 * `userId`, which lets Segment attach the earlier anonymous events to that user.
 *
 * Nothing about the machine or the person feeds it: it is a fresh UUID, and deleting the file
 * starts a new one.
 *
 * Returns `undefined`, and writes nothing, when:
 * - the run is in CI, where the config directory does not outlive the run, so a stored id
 *   would only mint a new "installation" every time;
 * - the file can't be read or created. Telemetry must never fail a command.
 *
 * A file that exists but doesn't hold a UUID is replaced, not trusted.
 *
 * The caller owns the opt-out: this must only be called once analytics is known to be enabled.
 */
export const getOrCreateAnonymousId = (
	configDir: string,
): string | undefined => {
	if (isCi()) {
		return undefined;
	}
	const path = join(configDir, ANONYMOUS_ID_FILE);
	try {
		const stored = readFileSync(path, "utf8").trim();
		if (UUID.test(stored)) {
			return stored;
		}
	} catch {
		// Missing or unreadable: fall through and create one.
	}
	try {
		const id = randomUUID();
		mkdirSync(configDir, { recursive: true });
		writeSecretFile(path, `${id}\n`);
		return id;
	} catch (err) {
		log.debug("Could not store the anonymous analytics id: %s", err);
		return undefined;
	}
};
