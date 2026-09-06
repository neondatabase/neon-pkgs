import { describe, expect, it } from "vitest";
import { getProject } from "../client/raw.gen.js";
import { createNeonClient } from "./client.js";
import {
	describeTransportFailure,
	NeonApiError,
	NeonAuthError,
	NeonError,
	NeonNetworkError,
	NeonNotFoundError,
	NeonOperationError,
	NeonRateLimitError,
	NeonTimeoutError,
	toNeonError,
	withCreated,
} from "./errors.js";

/**
 * Rename the class binding the way a bundler does, then construct. A name derived from the
 * constructor follows the rename; a literal does not. Without this, a regression to
 * `new.target.name` passes every test and only shows up in a minified build.
 */
/** Only the `name` property is touched, so that is all the class needs to expose. */
type NamedClass = { readonly name: string };

function nameAfterMinification(
	construct: () => NeonError,
	cls: NamedClass,
): string {
	const original = Object.getOwnPropertyDescriptor(cls, "name");
	Object.defineProperty(cls, "name", { value: "s", configurable: true });
	try {
		return construct().name;
	} finally {
		if (original) Object.defineProperty(cls, "name", original);
	}
}

const apiInit = { status: 500 };

describe("error names survive minification", () => {
	const cases: Array<[string, () => NeonError, NamedClass]> = [
		["NeonError", () => new NeonError("x", "client"), NeonError],
		["NeonApiError", () => new NeonApiError("x", apiInit), NeonApiError],
		[
			"NeonNotFoundError",
			() => new NeonNotFoundError("x", apiInit),
			NeonNotFoundError,
		],
		["NeonAuthError", () => new NeonAuthError("x", apiInit), NeonAuthError],
		[
			"NeonRateLimitError",
			() => new NeonRateLimitError("x", apiInit),
			NeonRateLimitError,
		],
		[
			"NeonOperationError",
			() =>
				new NeonOperationError("x", {
					operationId: "op-1",
					status: "failed",
				}),
			NeonOperationError,
		],
		["NeonTimeoutError", () => new NeonTimeoutError("x"), NeonTimeoutError],
		["NeonNetworkError", () => new NeonNetworkError("x"), NeonNetworkError],
	];

	for (const [expected, construct, cls] of cases) {
		it(`${expected} keeps its name when the class binding is renamed`, () => {
			expect(construct().name).toBe(expected);
			expect(nameAfterMinification(construct, cls)).toBe(expected);
		});
	}
});

describe("describeTransportFailure", () => {
	it("prefers an errno code over a message", () => {
		const cause = Object.assign(new Error("read ECONNRESET"), {
			code: "ECONNRESET",
		});
		expect(describeTransportFailure(cause)).toBe("ECONNRESET");
	});

	it("finds a code nested under fetch's generic wrapper", () => {
		const root = Object.assign(new Error(""), { code: "ETIMEDOUT" });
		const wrapper = new TypeError("fetch failed", { cause: root });
		expect(describeTransportFailure(wrapper)).toBe("ETIMEDOUT");
	});

	it("falls back to the deepest non-empty message", () => {
		const root = new Error("getaddrinfo ENOTFOUND console.neon.tech");
		const wrapper = new TypeError("fetch failed", { cause: root });
		expect(describeTransportFailure(wrapper)).toBe(
			"getaddrinfo ENOTFOUND console.neon.tech",
		);
	});

	it("keeps the outer message when the root cause has neither code nor message", () => {
		// The shape observed on a redirect the fetch client refused to follow.
		const root = new Error("");
		const wrapper = new TypeError("fetch failed", { cause: root });
		expect(describeTransportFailure(wrapper)).toBe("fetch failed");
	});

	it("reports a usable reason for a non-Error and for a cause cycle", () => {
		expect(describeTransportFailure("nope")).toBe("cause unavailable");

		const a = new Error("");
		const b = new Error("", { cause: a });
		a.cause = b;
		expect(describeTransportFailure(a)).toBe("cause unavailable");
	});
});

describe("toNeonError", () => {
	it("names the transport reason in the message and exposes it separately", () => {
		const cause = new TypeError("fetch failed", {
			cause: Object.assign(new Error(""), { code: "ECONNREFUSED" }),
		});
		const error = toNeonError(cause, undefined);

		expect(error).toBeInstanceOf(NeonNetworkError);
		expect(error.message).toBe(
			"Network error: no response received from the Neon API (ECONNREFUSED).",
		);
		expect((error as NeonNetworkError).reason).toBe("ECONNREFUSED");
		expect(error.cause).toBe(cause);
	});
});

describe("transport failures end to end", () => {
	it("surfaces the underlying errno through a real client call", async () => {
		const { client } = createNeonClient({
			apiKey: "test",
			retries: 0,
			fetch: async () => {
				throw new TypeError("fetch failed", {
					cause: Object.assign(new Error("read ECONNRESET"), {
						code: "ECONNRESET",
					}),
				});
			},
		});

		const res = await getProject({ client, path: { project_id: "p-1" } });

		expect(res.error).toBeInstanceOf(NeonNetworkError);
		expect(res.error?.message).toContain("(ECONNRESET)");
		expect((res.error as NeonNetworkError).reason).toBe("ECONNRESET");
	});
});

describe("withCreated", () => {
	it("keeps the wait error's subclass and kind", () => {
		const error = new NeonTimeoutError(
			"Timed out after 80ms waiting for 1 operation(s) to finish.",
		);
		const created = { id: "p-1", name: "test" };
		const attached = withCreated(error, created);
		expect(attached).toBe(error);
		expect(attached).toBeInstanceOf(NeonTimeoutError);
		expect(attached.kind).toBe("timeout");
		expect(attached.created).toEqual(created);
	});

	it("does not replace a created resource already on the error", () => {
		const error = new NeonError("x", "timeout", {
			created: { id: "first" },
		});
		expect(withCreated(error, { id: "second" }).created).toEqual({
			id: "first",
		});
	});
});
