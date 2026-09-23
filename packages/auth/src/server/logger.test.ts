import { describe, expect, test, vi } from "vitest";
import { resolveNeonAuthLogging } from "./logger";

describe("resolveNeonAuthLogging", () => {
	test("defaults to console-backed warn level when no options", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const log = resolveNeonAuthLogging();

		log.warn("hello");
		expect(warnSpy).toHaveBeenCalledWith("hello");
		warnSpy.mockRestore();
	});

	test("logLevel silent ignores custom logger", () => {
		const customWarn = vi.fn();
		const log = resolveNeonAuthLogging({
			logLevel: "silent",
			logger: { warn: customWarn },
		});

		log.warn("ignored");
		expect(customWarn).not.toHaveBeenCalled();
	});

	test("logLevel silent disables all output", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const log = resolveNeonAuthLogging({ logLevel: "silent" });

		log.warn("silent");
		log.error("silent");
		expect(warnSpy).not.toHaveBeenCalled();
		expect(errorSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
	});

	test("custom logger uses default warn level when logLevel omitted", () => {
		const calls = { error: 0, warn: 0, info: 0, debug: 0 };
		const log = resolveNeonAuthLogging({
			logger: {
				error: () => {
					calls.error++;
				},
				warn: () => {
					calls.warn++;
				},
				info: () => {
					calls.info++;
				},
				debug: () => {
					calls.debug++;
				},
			},
		});

		log.error("e");
		log.warn("w");
		log.info("i");
		log.debug("d");

		expect(calls).toEqual({ error: 1, warn: 1, info: 0, debug: 0 });
	});

	test("debug level emits all", () => {
		const calls = { error: 0, warn: 0, info: 0, debug: 0 };
		const log = resolveNeonAuthLogging({
			logLevel: "debug",
			logger: {
				error: () => calls.error++,
				warn: () => calls.warn++,
				info: () => calls.info++,
				debug: () => calls.debug++,
			},
		});

		log.error("e");
		log.warn("w");
		log.info("i");
		log.debug("d");

		expect(calls).toEqual({ error: 1, warn: 1, info: 1, debug: 1 });
	});
});
