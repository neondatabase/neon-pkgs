import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { CredentialInputs } from "@neon-internals/cli-core/auth_selection";
import { writeSecretFile } from "@neon-internals/cli-core/secure_file";
import type { Context } from "../context.js";

const FILE_PREFIX = "claimable-credential.";
const FILE_SUFFIX = ".json";
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export type StoredClaimableCredentials = {
	version: 1;
	origin: string;
	registrationId: string;
	projectId: string;
	branchId: string;
	identityAssertion: string;
	expiresAt: string;
};

export type ResolvedClaimableContext = {
	origin: string;
	projectId: string;
	branch?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

const assertProjectId = (projectId: string): void => {
	if (!PROJECT_ID.test(projectId)) {
		throw new Error(`Invalid Claimable Neon project ID "${projectId}".`);
	}
};

export const claimableCredentialsPath = (
	configDir: string,
	projectId: string,
): string => {
	assertProjectId(projectId);
	return join(configDir, `${FILE_PREFIX}${projectId}${FILE_SUFFIX}`);
};

const parseStoredCredentials = (
	value: unknown,
	path: string,
	expectedProjectId?: string,
): StoredClaimableCredentials => {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!nonEmptyString(value.origin) ||
		!nonEmptyString(value.registrationId) ||
		!nonEmptyString(value.projectId) ||
		!nonEmptyString(value.branchId) ||
		!nonEmptyString(value.identityAssertion) ||
		!nonEmptyString(value.expiresAt)
	) {
		throw new Error(
			`${path} does not contain a valid Claimable Neon credential. Delete it and run \`neon claim create\` again.`,
		);
	}
	assertProjectId(value.projectId);
	if (
		expectedProjectId !== undefined &&
		value.projectId !== expectedProjectId
	) {
		throw new Error(
			`${path} belongs to a different Claimable Neon project. Delete it and run \`neon claim create\` again.`,
		);
	}
	return {
		version: 1,
		origin: value.origin,
		registrationId: value.registrationId,
		projectId: value.projectId,
		branchId: value.branchId,
		identityAssertion: value.identityAssertion,
		expiresAt: value.expiresAt,
	};
};

export const writeClaimableCredentials = (
	configDir: string,
	credentials: StoredClaimableCredentials,
): void => {
	const path = claimableCredentialsPath(configDir, credentials.projectId);
	writeSecretFile(path, JSON.stringify(credentials));
};

export const readClaimableCredentials = (
	configDir: string,
	projectId: string,
): StoredClaimableCredentials | null => {
	const path = claimableCredentialsPath(configDir, projectId);
	if (!existsSync(path)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(
			`${path} is not valid JSON, so the Claimable Neon credential cannot be read. Delete it and run \`neon claim create\` again.`,
		);
	}
	return parseStoredCredentials(parsed, path, projectId);
};

export const listClaimableCredentials = (
	configDir: string,
): StoredClaimableCredentials[] => {
	if (!existsSync(configDir)) return [];
	return readdirSync(configDir)
		.filter(
			(name) =>
				name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX),
		)
		.sort()
		.map((name) => {
			const path = join(configDir, name);
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(path, "utf8"));
			} catch {
				throw new Error(
					`${path} is not valid JSON, so the Claimable Neon credential cannot be listed. Delete it and run \`neon claim create\` again.`,
				);
			}
			return parseStoredCredentials(parsed, path);
		})
		.sort((left, right) => left.projectId.localeCompare(right.projectId));
};

export const removeClaimableCredentials = (
	configDir: string,
	projectId: string,
): void => {
	const path = claimableCredentialsPath(configDir, projectId);
	try {
		unlinkSync(path);
	} catch (error) {
		if (
			isRecord(error) &&
			typeof error.code === "string" &&
			error.code === "ENOENT"
		) {
			return;
		}
		throw error;
	}
};

export const resolveClaimableContext = (
	context: Context,
): ResolvedClaimableContext | null => {
	const marker: unknown = context.claimable;
	if (marker === undefined) return null;
	if (!isRecord(marker)) {
		throw new Error(
			'The linked .neon file has an invalid "claimable" marker. Run `neon link` to replace it.',
		);
	}
	if (marker.version !== 1) {
		throw new Error(
			`Unsupported Claimable Neon context version in .neon. Update the Neon CLI before using this project.`,
		);
	}
	if (!nonEmptyString(marker.origin) || !nonEmptyString(context.projectId)) {
		throw new Error(
			'The linked .neon file has an incomplete "claimable" marker. Run `neon link` to replace it.',
		);
	}
	assertProjectId(context.projectId);
	return {
		origin: marker.origin,
		projectId: context.projectId,
		...(nonEmptyString(context.branch) ? { branch: context.branch } : {}),
	};
};

export const shouldUseClaimableCredentials = (
	inputs: CredentialInputs,
	profileFlag: string | undefined,
	context: Context,
): boolean =>
	inputs.apiKeyFlag.trim() === "" &&
	inputs.apiKeyEnv.trim() === "" &&
	inputs.profileEnv.trim() === "" &&
	(profileFlag === undefined || profileFlag.trim() === "") &&
	resolveClaimableContext(context) !== null;
