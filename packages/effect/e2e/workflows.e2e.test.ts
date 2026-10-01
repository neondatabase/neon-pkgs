import { ConfigProvider, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { afterAll, beforeAll, describe, expect } from "vitest";
import {
	layer,
	layerConfig,
	make,
	Neon,
	NeonAuthError,
	NeonNotFoundError,
	NeonRequestTimeoutError,
} from "../src/index.js";
import {
	config,
	createProject,
	DEFAULT_REGION,
	deleteProjectsNamed,
	detectApiKeyScope,
	e2eTest,
	uniqueProjectName,
} from "./helpers.js";

const MISSING_PROJECT_ID = "neon-ts-e2e-does-not-exist";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe.sequential("e2e — @neon/effect against the real API", () => {
	const names: string[] = [];
	const name = (suffix: string) => {
		const projectName = uniqueProjectName(suffix);
		names.push(projectName);
		return projectName;
	};

	beforeAll(async () => {
		const scope = await detectApiKeyScope();
		if (!scope.canCreate) {
			throw new Error(
				"@neon/effect e2e needs an org- or user-scoped key that can create projects.",
			);
		}
	});

	afterAll(() => deleteProjectsNamed(names));

	e2eTest("reads through make, layer, and layerConfig", async ({ track }) => {
		const projectId = await createProject({ name: name("effect-read") });
		track(projectId);
		const read = Effect.gen(function* () {
			const neon = yield* Neon;
			return yield* neon.projects.get({ projectId });
		});
		const { apiKey, orgId } = config();
		const fromConfig = layerConfig.pipe(
			Layer.provide(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({
						NEON_API_KEY: apiKey,
						...(orgId ? { NEON_ORG_ID: orgId } : {}),
					}),
				),
			),
		);

		const direct = await run(make(config()).projects.get({ projectId }));
		const viaLayer = await run(read.pipe(Effect.provide(layer(config()))));
		const viaConfig = await run(read.pipe(Effect.provide(fromConfig)));

		expect([direct.id, viaLayer.id, viaConfig.id]).toEqual([
			projectId,
			projectId,
			projectId,
		]);
	});

	e2eTest("maps real 404 and 401 responses to tagged errors", async () => {
		const neon = make(config());

		const status = await run(
			neon.projects.get({ projectId: MISSING_PROJECT_ID }).pipe(
				Effect.map(() => 200),
				Effect.catchTag("NeonNotFoundError", (error) => {
					expect(error).toBeInstanceOf(NeonNotFoundError);
					expect(error.requestId).toBeTruthy();
					return Effect.succeed(error.status);
				}),
			),
		);
		expect(status).toBe(404);

		const rejected = await run(
			Effect.flip(
				make(config({ apiKey: "napi_not_a_real_key" }))
					.projects.list()
					.pipe(Stream.runCollect),
			),
		);
		expect(rejected).toBeInstanceOf(NeonAuthError);
		expect([401, 403]).toContain(
			rejected instanceof NeonAuthError ? rejected.status : undefined,
		);
	});

	e2eTest("forwards call options at the right position", async () => {
		const neon = make(config());

		const projectsTimeout = await run(
			Effect.flip(
				neon.projects
					.list(undefined, { requestTimeoutMs: 1 })
					.pipe(Stream.runCollect),
			),
		);
		expect(projectsTimeout).toBeInstanceOf(NeonRequestTimeoutError);

		const requests: Request[] = [];
		const recording = make(
			config({
				fetch: (input, init) => {
					const request = new Request(input, init);
					requests.push(request);
					return fetch(request);
				},
			}),
		);
		await run(
			Effect.gen(function* () {
				const fiber = yield* Effect.forkChild(
					recording.projects.list().pipe(Stream.runCollect),
				);
				for (let i = 0; i < 200 && requests.length === 0; i++) {
					yield* Effect.sleep("5 millis");
				}
				yield* Fiber.interrupt(fiber);
			}),
		);
		expect(requests).toHaveLength(1);
		const [listRequest] = requests;
		expect(new URL(listRequest.url).searchParams.has("throwOnError")).toBe(
			false,
		);
		expect(listRequest.signal.aborted).toBe(true);

		const orgsTimeout = await run(
			Effect.flip(neon.user.organizations({ requestTimeoutMs: 1 })),
		);
		expect(orgsTimeout).toBeInstanceOf(NeonRequestTimeoutError);
	});

	e2eTest(
		"creates, connects, paginates, and recovers a wait timeout",
		async ({ track }) => {
			const neon = make(config());
			const projectName = name("effect");

			const created = await run(
				neon.projects.createAndConnect({
					name: projectName,
					region_id: DEFAULT_REGION,
				}),
			);
			track(created.project.id);
			const projectId = created.project.id;

			expect(created.project.name).toBe(projectName);
			expect(created.connectionString).toMatch(/^postgres(ql)?:\/\//);

			const main = await run(neon.branches.getDefault({ projectId }));
			const roles = await run(
				neon.postgres.roles.list({ projectId, branchId: main.id }),
			);
			expect(roles.length).toBeGreaterThan(0);

			for (const branchName of ["effect-a", "effect-b"]) {
				await run(
					neon.branches.create({
						projectId,
						name: branchName,
						noCompute: true,
					}),
				);
			}

			const all = await run(
				neon.branches
					.list({ projectId, limit: 1 })
					.pipe(Stream.runCollect),
			);
			const ids = all.map((branch) => branch.id);
			expect(new Set(ids).size).toBe(ids.length);
			expect(all.map((branch) => branch.name)).toEqual(
				expect.arrayContaining(["effect-a", "effect-b"]),
			);
			expect(all.length).toBeGreaterThanOrEqual(3);

			const first = await run(
				neon.branches
					.list({ projectId, limit: 1 })
					.pipe(Stream.take(1), Stream.runCollect),
			);
			expect(first).toHaveLength(1);

			const resumed = await run(
				neon.branches
					.create(
						{ projectId, name: "effect-wait" },
						{ waitForReadiness: true, wait: { timeoutMs: 1 } },
					)
					.pipe(
						Effect.map(() => "ready before the budget ran out"),
						Effect.catchTag("NeonWaitTimeoutError", (error) =>
							neon.operations
								.waitFor(
									{ operations: error.operations },
									{ timeoutMs: 120_000, pollIntervalMs: 500 },
								)
								.pipe(
									Effect.as(
										`resumed ${error.operations.length} operation(s)`,
									),
								),
						),
					),
			);
			expect(resumed).toMatch(/^resumed [1-9]/);
		},
	);

	e2eTest(
		"interrupting a fiber stops readiness polling",
		async ({ track }) => {
			let requests = 0;
			const countingFetch: typeof fetch = (input, init) => {
				requests += 1;
				return fetch(input, init);
			};
			const neon = make(config({ fetch: countingFetch }));
			const projectName = name("effect-interrupt");

			const project = await run(
				neon.projects.create(
					{ name: projectName, region_id: DEFAULT_REGION },
					{ waitForReadiness: true },
				),
			);
			track(project.id);

			requests = 0;
			const exit = await run(
				Effect.gen(function* () {
					const fiber = yield* Effect.forkChild(
						neon.branches.create(
							{
								projectId: project.id,
								name: "effect-interrupted",
							},
							{
								waitForReadiness: true,
								wait: { pollIntervalMs: 200 },
							},
						),
					);
					// The create request plus at least one poll means polling has begun.
					for (let i = 0; i < 200 && requests < 2; i++) {
						yield* Effect.sleep("50 millis");
					}
					expect(requests).toBeGreaterThanOrEqual(2);
					yield* Fiber.interrupt(fiber);
					return yield* Fiber.await(fiber);
				}),
			);
			const afterInterrupt = requests;
			await new Promise((resolve) => setTimeout(resolve, 1_000));

			expect(Exit.hasInterrupts(exit)).toBe(true);
			expect(requests).toBe(afterInterrupt);
		},
	);
});
