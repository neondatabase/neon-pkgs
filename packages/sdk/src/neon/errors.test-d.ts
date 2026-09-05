import { expectTypeOf, it } from "vitest";
import { NeonTimeoutError } from "./errors.js";

it("NeonTimeoutError requires source and timeoutMs", () => {
	const error = new NeonTimeoutError("x", {
		source: "wait",
		timeoutMs: 80,
	});
	expectTypeOf(error.source).toEqualTypeOf<"request" | "wait">();
	expectTypeOf(error.timeoutMs).toEqualTypeOf<number>();
	// @ts-expect-error source is readonly
	error.source = "request";
	// @ts-expect-error timeoutMs is readonly
	error.timeoutMs = 1;
	// @ts-expect-error init is required
	new NeonTimeoutError("x");
});
