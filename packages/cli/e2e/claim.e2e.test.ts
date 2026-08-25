import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { e2eTest, runCli } from "./helpers.js";

type CreatedClaim = {
	project_id: string;
	branch_id: string;
	state: string;
};

type ClaimStatus = {
	project_id: string;
	state: string;
	reconciled: boolean;
};

type BareProject = {
	id: string;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

const isolatedDirs = (): {
	configDir: string;
	contextFile: string;
	cwd: string;
} => {
	const root = mkdtempSync(join(tmpdir(), "neon-claim-e2e-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const configDir = join(root, "config");
	mkdirSync(configDir);
	return {
		configDir,
		contextFile: join(root, ".neon"),
		cwd: join(root, "workspace"),
	};
};

const anonymous = {
	apiKey: null,
	env: {
		NEON_API_KEY: undefined,
		NEON_PROFILE: undefined,
	},
} as const;

const claimHostArgs = (): string[] => {
	const host = process.env.CLAIMABLE_NEON_HOST;
	return host ? ["--claimable-host", host] : [];
};

const runAnonymousJson = async <T>(
	args: string[],
	dirs: { configDir: string; contextFile: string; cwd?: string },
): Promise<T> => {
	const result = await runCli(args, {
		...anonymous,
		configDir: dirs.configDir,
		contextFile: dirs.contextFile,
		...(dirs.cwd ? { cwd: dirs.cwd } : {}),
	});
	if (result.code !== 0) {
		throw new Error(
			`neon ${args.join(" ")} exited ${result.code}\n${result.stderr || result.stdout}`,
		);
	}
	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		throw new Error(
			`neon ${args.join(" ")} did not print JSON:\n${result.stdout}`,
		);
	}
};

describe.sequential("e2e — neon claim against live Claimable Neon", () => {
	e2eTest(
		"creates, uses through ensureAuth, reports status, and deletes by project id",
		async () => {
			const createdIn = isolatedDirs();
			mkdirSync(createdIn.cwd);
			let projectId: string | undefined;
			try {
				const created = await runAnonymousJson<CreatedClaim>(
					["claim", "create", "--no-env-pull", ...claimHostArgs()],
					createdIn,
				);
				projectId = created.project_id;
				expect(created.state).toBe("unclaimed");

				const fetched = await runAnonymousJson<BareProject>(
					["projects", "get", created.project_id],
					createdIn,
				);
				expect(fetched.id).toBe(created.project_id);

				const liveStatus = await runAnonymousJson<ClaimStatus>(
					["claim", "status", ...claimHostArgs()],
					createdIn,
				);
				expect(liveStatus).toMatchObject({
					project_id: created.project_id,
					reconciled: false,
				});
				expect(liveStatus.state).not.toBe("expired");

				const orphaned = isolatedDirs();
				const deleted = await runAnonymousJson<{
					project_id: string;
					state: string;
				}>(
					[
						"claim",
						"delete",
						created.project_id,
						"--yes",
						...claimHostArgs(),
					],
					{ ...orphaned, configDir: createdIn.configDir },
				);
				expect(deleted).toEqual({
					project_id: created.project_id,
					state: "deleted",
				});
				projectId = undefined;

				const listed = await runAnonymousJson<unknown[]>(
					["claim", "list"],
					{ ...orphaned, configDir: createdIn.configDir },
				);
				expect(listed).toEqual([]);
			} finally {
				if (projectId !== undefined) {
					await runCli(
						[
							"claim",
							"delete",
							projectId,
							"--yes",
							...claimHostArgs(),
						],
						{
							...anonymous,
							configDir: createdIn.configDir,
							contextFile: createdIn.contextFile,
						},
					);
				}
			}
		},
	);
});
