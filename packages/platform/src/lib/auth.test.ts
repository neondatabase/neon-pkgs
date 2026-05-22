import { afterEach, describe, expect, test } from "vitest";
import { readNeonctlCredentials, resolveApiKey } from "./auth.js";
import { makeTempRepo } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function setupHome(files: Record<string, string | null>): string {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

describe("readNeonctlCredentials", () => {
	test("reads access_token from <home>/.config/neonctl/credentials.json by default", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "oauth-token-abc",
				refresh_token: "rt-xyz",
			}),
		});
		const creds = readNeonctlCredentials({ home, env: {} });
		expect(creds?.access_token).toBe("oauth-token-abc");
		expect(creds?.refresh_token).toBe("rt-xyz");
	});

	test("honours NEONCTL_CONFIG_DIR over the default location", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "default-loc",
			}),
			"custom/credentials.json": JSON.stringify({
				access_token: "from-env-dir",
			}),
		});
		const creds = readNeonctlCredentials({
			home,
			env: { NEONCTL_CONFIG_DIR: `${home}/custom` },
		});
		expect(creds?.access_token).toBe("from-env-dir");
	});

	test("honours explicit configDir over the env var", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "default-loc",
			}),
			"env/credentials.json": JSON.stringify({
				access_token: "from-env-dir",
			}),
			"opt/credentials.json": JSON.stringify({
				access_token: "from-option",
			}),
		});
		const creds = readNeonctlCredentials({
			home,
			env: { NEONCTL_CONFIG_DIR: `${home}/env` },
			configDir: `${home}/opt`,
		});
		expect(creds?.access_token).toBe("from-option");
	});

	test("returns null when the file is missing", () => {
		const home = setupHome({ ".config/neonctl/.keep": "" });
		expect(readNeonctlCredentials({ home, env: {} })).toBeNull();
	});

	test("returns null on malformed JSON instead of throwing", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": "not json",
		});
		expect(readNeonctlCredentials({ home, env: {} })).toBeNull();
	});

	test("returns null when access_token is missing or empty", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				refresh_token: "rt-only",
			}),
		});
		expect(readNeonctlCredentials({ home, env: {} })).toBeNull();
		const home2 = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "",
			}),
		});
		expect(readNeonctlCredentials({ home: home2, env: {} })).toBeNull();
	});

	test("returns null when no home dir resolvable and no override", () => {
		expect(readNeonctlCredentials({ env: {} })).toBeNull();
	});

	test("falls back to USERPROFILE on Windows-style env", () => {
		const winHome = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "win-token",
			}),
		});
		const creds = readNeonctlCredentials({ env: { USERPROFILE: winHome } });
		expect(creds?.access_token).toBe("win-token");
	});
});

describe("resolveApiKey — priority chain", () => {
	test("explicit option wins over env wins over credentials.json", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "from-file",
			}),
		});
		expect(
			resolveApiKey({
				apiKey: "from-option",
				env: { NEON_API_KEY: "from-env" },
				home,
			}),
		).toEqual({ token: "from-option", source: "option" });

		expect(
			resolveApiKey({ env: { NEON_API_KEY: "from-env" }, home }),
		).toEqual({
			token: "from-env",
			source: "env",
		});

		expect(resolveApiKey({ env: {}, home })).toEqual({
			token: "from-file",
			source: "neonctl",
		});
	});

	test("returns null when no source provides a token", () => {
		const home = setupHome({ ".config/neonctl/.keep": "" });
		expect(resolveApiKey({ env: {}, home })).toBeNull();
	});

	test("treats whitespace-only option / env as missing", () => {
		const home = setupHome({
			".config/neonctl/credentials.json": JSON.stringify({
				access_token: "from-file",
			}),
		});
		expect(
			resolveApiKey({
				apiKey: "   ",
				env: { NEON_API_KEY: "   " },
				home,
			}),
		).toEqual({ token: "from-file", source: "neonctl" });
	});

	test("trims whitespace around the resolved token", () => {
		const home = setupHome({ ".config/neonctl/.keep": "" });
		expect(resolveApiKey({ apiKey: "  napi_x  ", env: {}, home })).toEqual({
			token: "napi_x",
			source: "option",
		});
	});
});
