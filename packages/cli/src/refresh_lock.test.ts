import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withExclusiveLock } from "./refresh_lock.js";

let dir = "";

afterEach(() => {
	if (dir !== "") rmSync(dir, { recursive: true, force: true });
	dir = "";
});

describe("withExclusiveLock", () => {
	it("runs the critical section of two waiters one after the other", async () => {
		dir = mkdtempSync(join(tmpdir(), "neon-refresh-lock-"));
		const lockPath = join(dir, "lock");
		const seen: number[] = [];
		let inside = 0;
		let overlap = false;

		const hold = async (id: number) => {
			await withExclusiveLock(lockPath, async () => {
				inside += 1;
				if (inside > 1) overlap = true;
				await new Promise((resolve) => setTimeout(resolve, 40));
				seen.push(id);
				inside -= 1;
			});
		};

		await Promise.all([hold(1), hold(2)]);

		expect(overlap).toBe(false);
		expect(seen.sort()).toEqual([1, 2]);
	});

	it("steals a lock file that has gone stale", async () => {
		dir = mkdtempSync(join(tmpdir(), "neon-refresh-lock-"));
		const lockPath = join(dir, "lock");
		writeFileSync(lockPath, "", { mode: 0o600 });
		const longAgo = new Date(Date.now() - 120_000);
		utimesSync(lockPath, longAgo, longAgo);

		await expect(
			withExclusiveLock(lockPath, async () => "ok"),
		).resolves.toBe("ok");
	});
});
