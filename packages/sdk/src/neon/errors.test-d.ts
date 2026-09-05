import { expectTypeOf, it } from "vitest";
import type { Project } from "../client/types.gen.js";
import { createNeonClient } from "./client.js";
import {
	type NeonAbortError,
	NeonApiError,
	type NeonApiErrorKind,
	type NeonAuthError,
	type NeonClientError,
	NeonError,
	type NeonErrorUnion,
	type NeonNetworkError,
	NeonNotFoundError,
	type NeonOperationError,
	type NeonRateLimitError,
	type NeonTimeoutError,
	toNeonError,
} from "./errors.js";
import type { NeonResult } from "./result.js";

it("kind narrows NeonResult.error to the matching subclass", async () => {
	const neon = createNeonClient({ apiKey: "x" });
	const { error }: NeonResult<Project> = await neon.projects.get("p");

	if (error?.kind === "not_found") {
		expectTypeOf(error).toEqualTypeOf<NeonNotFoundError>();
		expectTypeOf(error.status).toEqualTypeOf<number>();
		expectTypeOf(error.requestId).toEqualTypeOf<string | undefined>();
		// @ts-expect-error reason is a network-error field
		error.reason;
	}

	if (error?.kind === "network") {
		expectTypeOf(error).toEqualTypeOf<NeonNetworkError>();
		expectTypeOf(error.reason).toEqualTypeOf<string>();
		// @ts-expect-error status is an API-error field
		error.status;
	}

	if (error?.kind === "client") {
		expectTypeOf(error).toEqualTypeOf<NeonClientError>();
	}

	if (error?.kind === "api") {
		expectTypeOf(error.kind).toEqualTypeOf<"api">();
		expectTypeOf(error.status).toEqualTypeOf<number>();
		expectTypeOf(error).toEqualTypeOf<
			NeonApiError & { readonly kind: "api" }
		>();
	}

	if (error?.kind === "aborted") {
		expectTypeOf(error).toEqualTypeOf<NeonAbortError>();
	}

	if (error?.kind === "timeout") {
		expectTypeOf(error).toEqualTypeOf<NeonTimeoutError>();
	}

	if (error?.kind === "operation") {
		expectTypeOf(error).toEqualTypeOf<NeonOperationError>();
		expectTypeOf(error.operationId).toEqualTypeOf<string>();
	}

	if (error?.kind === "auth") {
		expectTypeOf(error).toEqualTypeOf<NeonAuthError>();
		expectTypeOf(error.status).toEqualTypeOf<number>();
	}

	if (error?.kind === "rate_limit") {
		expectTypeOf(error).toEqualTypeOf<NeonRateLimitError>();
		expectTypeOf(error.status).toEqualTypeOf<number>();
	}
});

it("a switch over kind is exhaustive", async () => {
	const neon = createNeonClient({ apiKey: "x" });
	const { error }: NeonResult<Project> = await neon.projects.get("p");
	if (!error) return;

	switch (error.kind) {
		case "api":
		case "not_found":
		case "auth":
		case "rate_limit":
		case "operation":
		case "timeout":
		case "aborted":
		case "network":
		case "client":
			break;
		default: {
			expectTypeOf(error).toBeNever();
		}
	}
});

it("instanceof NeonApiError exposes status on the union", async () => {
	const neon = createNeonClient({ apiKey: "x" });
	const { error }: NeonResult<Project> = await neon.projects.get("p");
	if (error instanceof NeonApiError) {
		expectTypeOf(error.status).toEqualTypeOf<number>();
		expectTypeOf(error.kind).toEqualTypeOf<NeonApiErrorKind>();
	}
	if (error instanceof NeonError) {
		expectTypeOf(error).toEqualTypeOf<NeonErrorUnion>();
	}
});

it("toNeonError returns the union", () => {
	expectTypeOf(
		toNeonError(undefined, undefined),
	).toEqualTypeOf<NeonErrorUnion>();
});

it("NeonApiError construction cannot claim a subclass kind", () => {
	expectTypeOf(
		new NeonApiError("x", { status: 500 }).kind,
	).toEqualTypeOf<NeonApiErrorKind>();
	new NeonApiError("x", {
		status: 404,
		// @ts-expect-error a 404 must be NeonNotFoundError, not NeonApiError with kind not_found
		kind: "not_found",
	});
});

it("HTTP subclasses remain assignable to NeonApiError", () => {
	const error: NeonApiError = new NeonNotFoundError("x", { status: 404 });
	expectTypeOf(error.status).toEqualTypeOf<number>();
	expectTypeOf(error.kind).toEqualTypeOf<NeonApiErrorKind>();
});

it("NeonApiError is not a generic that can advertise a false kind", () => {
	// @ts-expect-error NeonApiError takes no type arguments
	new NeonApiError<"not_found">("x", { status: 500 });
});
