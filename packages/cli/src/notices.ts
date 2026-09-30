import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";
import { writeJsonFile } from "./utils/json_file.js";

/**
 * When each terminal notice was last shown, so a notice repeats on its own interval rather
 * than on every command. Kept apart from the update cache: that cache is tied to one install
 * source and rewritten by a background worker, while a notice can come from any copy.
 *
 * Throttling is best effort. Two commands started together can both show a due notice.
 */
const NOTICES_FILE = "notices.json";

export type NoticeId = "update" | "duplicate-installs";

/** Notice id to the epoch milliseconds it was last shown. */
export type NoticeLog = Record<string, number>;

/**
 * Keeps ids this version doesn't know, so an older and a newer CLI sharing one config
 * directory don't erase each other's timestamps.
 */
export const parseNoticeLog = (raw: string): NoticeLog => {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, number] =>
				typeof entry[1] === "number" && Number.isFinite(entry[1]),
		),
	);
};

export const isNoticeDue = (
	shownAt: number | undefined,
	now: number,
	intervalMs: number,
): boolean => shownAt === undefined || now - shownAt >= intervalMs;

const readNoticeLog = (path: string): NoticeLog => {
	try {
		return parseNoticeLog(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
};

type ShowNoticeOptions = {
	configDir: string;
	id: NoticeId;
	intervalMs: number;
	message: string;
	now?: number;
};

/** Print `message` as a warning unless notice `id` was shown within `intervalMs`. */
export const showNotice = ({
	configDir,
	id,
	intervalMs,
	message,
	now = Date.now(),
}: ShowNoticeOptions): void => {
	const path = join(configDir, NOTICES_FILE);
	const shown = readNoticeLog(path);
	if (!isNoticeDue(shown[id], now, intervalMs)) return;

	log.warning("%s", message);
	writeJsonFile(path, { ...shown, [id]: now }, "CLI notice log");
};
