import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeEnvFile } from "../env_file.js";
import { BootstrapInputError } from "./bootstrap.js";

/**
 * An environment variable a deployable template needs, declared in the
 * `inputs` list of its `template.json`. Its `neon.ts` reads the value from
 * `process.env`, and `bootstrap --deploy` writes it to `.env.local` first.
 */
export type TemplateInput = {
	name: string;
	description?: string;
	/** Never printed. */
	secret?: boolean;
	/** `"token"`: a random 32-byte base64url value when none is given. */
	generate?: "token";
	/** Used when no value is given. */
	default?: string;
};

const INPUT_NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The inputs a scaffolded template declares in its `template.json`, or none
 * when the template has no `template.json`. Malformed entries are an error:
 * the template's `neon.ts` would fail later with a less useful message.
 */
export const readTemplateInputs = (dir: string): TemplateInput[] => {
	const path = join(dir, "template.json");
	if (!existsSync(path)) return [];
	let manifest: unknown;
	try {
		manifest = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new BootstrapInputError(
			"The template's template.json is not valid JSON.",
			"TEMPLATE_MANIFEST_INVALID",
		);
	}
	const inputs =
		typeof manifest === "object" &&
		manifest !== null &&
		"inputs" in manifest
			? manifest.inputs
			: undefined;
	if (inputs === undefined) return [];
	if (!Array.isArray(inputs)) {
		throw new BootstrapInputError(
			'The template\'s template.json "inputs" must be a list.',
			"TEMPLATE_MANIFEST_INVALID",
		);
	}
	return inputs.map((input: unknown): TemplateInput => {
		if (
			typeof input !== "object" ||
			input === null ||
			!("name" in input) ||
			typeof input.name !== "string" ||
			!INPUT_NAME.test(input.name)
		) {
			throw new BootstrapInputError(
				"Each template.json input needs an upper-case environment variable name.",
				"TEMPLATE_MANIFEST_INVALID",
			);
		}
		const value = input as Record<string, unknown>;
		return {
			name: input.name,
			...(typeof value.description === "string"
				? { description: value.description }
				: {}),
			...(value.secret === true ? { secret: true } : {}),
			...(value.generate === "token"
				? { generate: "token" as const }
				: {}),
			...(typeof value.default === "string"
				? { default: value.default }
				: {}),
		};
	});
};

/** Parses repeated `--env KEY=VALUE` flags. */
export const parseEnvAssignments = (
	assignments: readonly string[] = [],
): Record<string, string> => {
	const values: Record<string, string> = {};
	for (const assignment of assignments) {
		const separator = assignment.indexOf("=");
		const name = separator > 0 ? assignment.slice(0, separator) : "";
		if (!INPUT_NAME.test(name)) {
			throw new BootstrapInputError(
				`--env expects KEY=VALUE with an upper-case KEY, got "${separator > 0 ? name : assignment}".`,
				"ENV_ASSIGNMENT_INVALID",
			);
		}
		values[name] = assignment.slice(separator + 1);
	}
	return values;
};

/**
 * Resolves a value for every input: `--env` first, then a generated token,
 * then the default, then `ask` (interactive only). Without a way to get a
 * value, the error names the `--env` flag to pass.
 */
export const resolveTemplateInputs = async (
	inputs: readonly TemplateInput[],
	options: {
		provided: Record<string, string>;
		ask?: (input: TemplateInput) => Promise<string | undefined>;
	},
): Promise<{ values: Record<string, string>; generated: string[] }> => {
	const values: Record<string, string> = {};
	const generated: string[] = [];
	for (const input of inputs) {
		const given = options.provided[input.name];
		if (given !== undefined) {
			values[input.name] = given;
		} else if (input.generate === "token") {
			values[input.name] = randomBytes(32).toString("base64url");
			generated.push(input.name);
		} else if (input.default !== undefined) {
			values[input.name] = input.default;
		} else {
			const answer = await options.ask?.(input);
			if (answer === undefined || answer === "") {
				throw new BootstrapInputError(
					`The template needs ${input.name}${input.description ? ` (${input.description})` : ""}. Pass --env ${input.name}=<value>.`,
					"TEMPLATE_INPUT_MISSING",
				);
			}
			values[input.name] = answer;
		}
	}
	return { values, generated };
};

/**
 * Writes the input values into `.env.local`, keeping any lines already there.
 * A new file is created readable only by the owner, because it holds secrets.
 */
export const writeTemplateEnv = (
	dir: string,
	values: Record<string, string>,
): string => {
	const path = join(dir, ".env.local");
	if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
	mergeEnvFile(path, values);
	return path;
};
