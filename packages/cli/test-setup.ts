import { beforeAll } from "vitest";

beforeAll(() => {
	process.env.CI = "true";
	// Tests that clear CI for a child CLI would otherwise get the skills notice, which reads the
	// developer's own skills lock and checks it against GitHub.
	process.env.NO_UPDATE_NOTIFIER = "1";
	process.argv.push("--no-color");
	process.env.FORCE_COLOR = "false";
});
