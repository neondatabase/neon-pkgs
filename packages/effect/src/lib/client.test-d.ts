import type {
	Branch,
	CurrentUserInfoResponse,
	Operation,
	Project,
	ProjectListItem,
	RegionResponse,
	Role,
	ScheduleTrigger,
	NeonNotFoundError as SdkNotFoundError,
	StorageObjectCreatedTrigger,
} from "@neon/sdk";
import { Effect, type Stream } from "effect";
import { describe, expectTypeOf, it } from "vitest";
import type { NeonEffectClient } from "./client.js";
import type { NeonEffectError, NeonWaitTimeoutError } from "./errors.js";

declare const neon: NeonEffectClient;
declare const operations: readonly Operation[];

describe("NeonEffectClient", () => {
	it("turns paginated lists into Streams of items", () => {
		expectTypeOf(neon.projects.list()).toEqualTypeOf<
			Stream.Stream<ProjectListItem, NeonEffectError>
		>();
		expectTypeOf(neon.branches.list({ projectId: "p" })).toEqualTypeOf<
			Stream.Stream<Branch, NeonEffectError>
		>();
	});

	it("turns every other call into an Effect", () => {
		expectTypeOf(neon.projects.get({ projectId: "p" })).toEqualTypeOf<
			Effect.Effect<Project, NeonEffectError>
		>();
		expectTypeOf(neon.user.me()).toEqualTypeOf<
			Effect.Effect<CurrentUserInfoResponse, NeonEffectError>
		>();
		expectTypeOf(neon.operations.waitFor({ operations })).toEqualTypeOf<
			Effect.Effect<void, NeonEffectError>
		>();
		expectTypeOf(
			neon.postgres.roles.password({
				projectId: "p",
				branchId: "b",
				roleName: "r",
			}),
		).toEqualTypeOf<Effect.Effect<string, NeonEffectError>>();
		expectTypeOf(
			neon.postgres.roles.list({ projectId: "p", branchId: "b" }),
		).toEqualTypeOf<Effect.Effect<Role[], NeonEffectError>>();
	});

	it("keeps array-returning methods that are not paginated as Effects", () => {
		expectTypeOf(neon.regions.list()).toEqualTypeOf<
			Effect.Effect<RegionResponse[], NeonEffectError>
		>();
	});

	it("keeps per-type trigger overloads", () => {
		expectTypeOf(
			neon.triggers.create({
				projectId: "p",
				branchId: "b",
				type: "schedule",
				name: "nightly",
				function_slug: "fn",
				schedule: { cron: "0 0 * * *" },
			}),
		).toEqualTypeOf<Effect.Effect<ScheduleTrigger, NeonEffectError>>();
		expectTypeOf(
			neon.triggers.create({
				projectId: "p",
				branchId: "b",
				type: "storage_object_created",
				name: "uploads",
				function_slug: "fn",
				storage_object_created: { bucket_name: "b" },
			}),
		).toEqualTypeOf<
			Effect.Effect<StorageObjectCreatedTrigger, NeonEffectError>
		>();
	});

	it("accepts each method's own options, minus signal and throwOnError", () => {
		neon.user.me({ requestTimeoutMs: 5_000 });
		neon.projects.list(undefined, { requestTimeoutMs: 5_000 });
		neon.branches.create(
			{ projectId: "p", noCompute: true },
			{ waitForReadiness: true, wait: { timeoutMs: 1_000 } },
		);
		neon.operations.waitFor(
			{ operations },
			{ timeoutMs: 30_000, pollIntervalMs: 250 },
		);

		// @ts-expect-error interruption replaces `signal`
		neon.projects.get({ projectId: "p" }, { signal: AbortSignal.abort() });
		// @ts-expect-error failures always go to the error channel
		neon.projects.get({ projectId: "p" }, { throwOnError: false });
		// @ts-expect-error waitFor is budgeted by `timeoutMs`, not `requestTimeoutMs`
		neon.operations.waitFor({ operations }, { requestTimeoutMs: 1 });
		// @ts-expect-error named parameters are checked
		neon.projects.get({ project_id: "p" });
		// @ts-expect-error the raw client is not exposed
		neon.client;
	});

	it("narrows errors by tag and keeps the SDK error as cause", () => {
		const recovered = neon.projects.get({ projectId: "p" }).pipe(
			Effect.catchTag("NeonNotFoundError", (error) => {
				expectTypeOf(error.status).toEqualTypeOf<number>();
				expectTypeOf(error.requestId).toEqualTypeOf<
					string | undefined
				>();
				expectTypeOf(error.cause).toEqualTypeOf<SdkNotFoundError>();
				return Effect.succeed(undefined);
			}),
		);
		expectTypeOf(recovered).toEqualTypeOf<
			Effect.Effect<
				Project | undefined,
				Exclude<NeonEffectError, { _tag: "NeonNotFoundError" }>
			>
		>();

		neon.branches.create({ projectId: "p" }).pipe(
			Effect.catchTag("NeonWaitTimeoutError", (error) => {
				expectTypeOf(error).toEqualTypeOf<NeonWaitTimeoutError>();
				return neon.operations.waitFor({
					operations: error.operations,
				});
			}),
		);
	});
});
