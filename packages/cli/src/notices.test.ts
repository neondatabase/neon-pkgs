import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNoticeDue, parseNoticeLog, showNotice } from "./notices.js";

const DAY = 24 * 60 * 60 * 1000;

describe("parseNoticeLog", () => {
	it("keeps every finite timestamp, including ids this version doesn't know", () => {
		expect(
			parseNoticeLog(
				JSON.stringify({
					update: 100,
					"duplicate-installs": 200,
					"from-a-newer-cli": 300,
				}),
			),
		).toEqual({
			update: 100,
			"duplicate-installs": 200,
			"from-a-newer-cli": 300,
		});
	});

	it("drops values that are not timestamps", () => {
		expect(
			parseNoticeLog('{"update":"100","other":null,"kept":1}'),
		).toEqual({ kept: 1 });
	});

	it.each([
		"",
		"not json",
		"[]",
		"null",
		"1",
	])("reads %s as an empty log", (raw) => {
		expect(parseNoticeLog(raw)).toEqual({});
	});
});

describe("isNoticeDue", () => {
	it("is due when never shown and once the interval has passed", () => {
		expect(isNoticeDue(undefined, 0, DAY)).toBe(true);
		expect(isNoticeDue(0, DAY, DAY)).toBe(true);
	});

	it("is not due within the interval", () => {
		expect(isNoticeDue(0, DAY - 1, DAY)).toBe(false);
	});
});

describe("showNotice", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) {
			rmSync(dirs.pop() ?? "", { force: true, recursive: true });
		}
	});

	const configDir = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "neon-notices-"));
		dirs.push(dir);
		return dir;
	};
	const logOf = (dir: string): unknown =>
		JSON.parse(readFileSync(join(dir, "notices.json"), "utf8"));
	const show = (dir: string, now: number) =>
		showNotice({
			configDir: dir,
			id: "duplicate-installs",
			intervalMs: DAY,
			message: "Multiple Neon CLI installs found on PATH",
			now,
		});

	it("records a shown notice and skips it until the interval passes", () => {
		const dir = configDir();

		show(dir, 1000);
		expect(logOf(dir)).toEqual({ "duplicate-installs": 1000 });

		show(dir, 1000 + DAY - 1);
		expect(logOf(dir)).toEqual({ "duplicate-installs": 1000 });

		show(dir, 1000 + DAY);
		expect(logOf(dir)).toEqual({ "duplicate-installs": 1000 + DAY });
	});

	it("keeps the other notices' timestamps", () => {
		const dir = configDir();
		writeFileSync(
			join(dir, "notices.json"),
			JSON.stringify({ update: 5, "from-a-newer-cli": 6 }),
		);

		show(dir, 1000);

		expect(logOf(dir)).toEqual({
			update: 5,
			"from-a-newer-cli": 6,
			"duplicate-installs": 1000,
		});
	});

	it("does not throw when the log can't be written", () => {
		const dir = configDir();
		const notADirectory = join(dir, "file");
		writeFileSync(notADirectory, "");

		expect(() => show(notADirectory, 1000)).not.toThrow();
		expect(existsSync(join(dir, "notices.json"))).toBe(false);
	});
});
