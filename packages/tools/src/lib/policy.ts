import { NeonClientError } from "@neon/sdk";
import type {
	NeonSecretField,
	NeonSecretsMode,
	NeonTool,
	NeonToolExecutionContext,
	NeonToolMetadata,
} from "./operation.js";
import { redactSecretFields } from "./redact.js";

export interface NeonToolPolicyOptions {
	/** The default for `readOnly` in every execution context. */
	readOnly?: boolean;
	/** The default for `secrets` in every execution context; `"all"` when unset. */
	secrets?: NeonSecretsMode;
}

/** What a `tools` predicate sees: a tool without its `execute`. */
export type NeonToolDescriptor = Pick<
	NeonTool,
	| "operationId"
	| "id"
	| "title"
	| "description"
	| "annotations"
	| "requiresApproval"
	| "metadata"
>;

export type NeonToolPredicate = (tool: NeonToolDescriptor) => boolean;

export const toolDescriptor = (tool: NeonTool): NeonToolDescriptor => ({
	operationId: tool.operationId,
	id: tool.id,
	title: tool.title,
	description: tool.description,
	annotations: tool.annotations,
	requiresApproval: tool.requiresApproval,
	metadata: tool.metadata,
});

export type NeonToolCallGuard = (context?: NeonToolExecutionContext) => void;

const secretsMode = (
	options: NeonToolPolicyOptions,
	context?: NeonToolExecutionContext,
): NeonSecretsMode => context?.secrets ?? options.secrets ?? "all";

const hides = (mode: NeonSecretsMode, field: NeonSecretField): boolean =>
	mode === "none" || (mode === "setup" && field.kind !== "setup");

/** The secret fields `mode` replaces with `REDACTED_SECRET`. */
export const hiddenSecretFields = (
	metadata: Pick<NeonToolMetadata, "secretOutputFields">,
	mode: NeonSecretsMode,
): NeonSecretField[] =>
	metadata.secretOutputFields.filter((field) => hides(mode, field));

/** The tool refuses under `mode` because its whole result would be hidden. */
export const withheldUnderSecrets = (
	metadata: Pick<
		NeonToolMetadata,
		"secretOutputFields" | "returnsOnlySecrets"
	>,
	mode: NeonSecretsMode,
): boolean =>
	metadata.returnsOnlySecrets &&
	hiddenSecretFields(metadata, mode).length > 0;

/** Throws for a call the effective policy forbids. */
export const toolCallGuard =
	(
		tool: NeonTool,
		options: NeonToolPolicyOptions,
		publishedId: string,
	): NeonToolCallGuard =>
	(context) => {
		const readOnly = context?.readOnly ?? options.readOnly;
		if (readOnly === true && !tool.metadata.readOnlySafe) {
			throw new NeonClientError(
				`${publishedId} is unavailable in read-only mode because it can change Neon resources or returns a connection string or role password.`,
			);
		}
		const secrets = secretsMode(options, context);
		if (withheldUnderSecrets(tool.metadata, secrets)) {
			throw new NeonClientError(
				`${publishedId} is unavailable with secrets: "${secrets}" because its result is a secret.`,
			);
		}
	};

/**
 * SQL tools read the effective `readOnly` to open a `READ ONLY` transaction.
 * Redaction runs inside `onExecute`, so a tracking hook sees the redacted result.
 */
export const applyToolPolicy = <Tool extends NeonTool>(
	tool: Tool,
	options: NeonToolPolicyOptions,
	guard: NeonToolCallGuard,
): Tool => {
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		execute: async (input, context) => {
			guard(context);
			const readOnly = context?.readOnly ?? options.readOnly;
			const result = await execute(
				input,
				readOnly === undefined ? context : { ...context, readOnly },
			);
			const hidden = hiddenSecretFields(
				tool.metadata,
				secretsMode(options, context),
			);
			if (hidden.length === 0) {
				return result;
			}
			return {
				...result,
				data: redactSecretFields(
					result.data,
					hidden.map((field) => field.path),
				),
			};
		},
	};
};
