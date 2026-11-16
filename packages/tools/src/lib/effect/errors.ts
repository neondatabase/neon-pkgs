import { type NeonEffectError, toNeonEffectError } from "@neon/effect";
import { NeonDbError } from "@neondatabase/serverless";
import { Data } from "effect";
import * as z from "zod";

/** The tool input failed its schema. */
export class NeonToolInputError extends Data.TaggedError("NeonToolInputError")<{
	readonly message: string;
	readonly issues: z.ZodError["issues"];
	/** The `ZodError` the input schema threw. */
	readonly cause: z.ZodError;
}> {}

/** Postgres rejected the statement. */
export class NeonSqlError extends Data.TaggedError("NeonSqlError")<{
	readonly message: string;
	/** The SQLSTATE Postgres answered with. */
	readonly code: string;
	readonly position: string | undefined;
	readonly detail: string | undefined;
	readonly hint: string | undefined;
	readonly where: string | undefined;
	/** The driver's `NeonDbError`. */
	readonly cause: Error;
}> {}

/** The SQL endpoint failed before Postgres answered, so there is no SQLSTATE. */
export class NeonSqlConnectionError extends Data.TaggedError(
	"NeonSqlConnectionError",
)<{
	readonly message: string;
	/** The driver's `NeonDbError`. */
	readonly cause: Error;
}> {}

/**
 * Every error an Effect tool can fail with. A cancelled call is an interrupted
 * fiber, so aborts have no counterpart here.
 */
export type NeonToolError =
	| NeonEffectError
	| NeonToolInputError
	| NeonSqlError
	| NeonSqlConnectionError;

const sqlError = (error: NeonDbError): NeonSqlError | NeonSqlConnectionError =>
	error.code === undefined || error.code === ""
		? new NeonSqlConnectionError({ message: error.message, cause: error })
		: new NeonSqlError({
				message: error.message,
				code: error.code,
				position: error.position,
				detail: error.detail,
				hint: error.hint,
				where: error.where,
				cause: error,
			});

/**
 * Map a failure a tool threw to its tagged error. Anything else, including the
 * aborts an interrupted call produces, is rethrown so Effect records a defect.
 */
export const toNeonToolError = (error: unknown): NeonToolError => {
	if (error instanceof z.ZodError) {
		return new NeonToolInputError({
			message: error.message,
			issues: error.issues,
			cause: error,
		});
	}
	if (error instanceof NeonDbError) {
		return sqlError(error);
	}
	return toNeonEffectError(error);
};
