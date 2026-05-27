/**
 * Public surface for the `errors` namespace exported from `@neondatabase/platform/v1`.
 *
 * This barrel exists so `v1.ts` can do `export * as errors from "./lib/errors-public.js"`
 * without leaking internal helpers (`bugReportFooter`) that the rest of the package uses
 * to compose error messages. The base class `PlatformError` and the `ErrorCode` enum stay
 * at the top level of the public API (and are also re-exported here) so callers can
 * either `import { PlatformError } from "..."` or reach for `errors.PlatformError`.
 */
export {
	ConfigLoadError,
	ConfigValidationError,
	ErrorCode,
	MissingContextError,
	PlatformError,
	PushAbortedError,
	PushConflictError,
} from "./errors.js";
