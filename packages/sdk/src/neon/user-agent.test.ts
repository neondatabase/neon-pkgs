import { describe, expect, it } from "vitest";
import { getProject } from "../client/raw.gen.js";
import { createNeonClient } from "./client.js";

/** Records the request the client would have sent, and answers it. */
function neonRecording(userAgent?: string) {
	const requests: Request[] = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		...(userAgent ? { userAgent } : {}),
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(JSON.stringify({ project: { id: "p-1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, requests };
}

describe("userAgent", () => {
	it("is sent on ergonomic resource calls", async () => {
		const { neon, requests } = neonRecording("my-cli/1.2.0");

		await neon.projects.get("p-1");

		expect(requests[0]?.headers.get("User-Agent")).toBe("my-cli/1.2.0");
	});

	it("is sent on raw calls, which share the configured client", async () => {
		const { neon, requests } = neonRecording("my-cli/1.2.0");

		await getProject({ client: neon.client, path: { project_id: "p-1" } });

		expect(requests[0]?.headers.get("User-Agent")).toBe("my-cli/1.2.0");
	});

	it("does not set the header when unset, leaving the runtime default", async () => {
		const { neon, requests } = neonRecording();

		await neon.projects.get("p-1");

		expect(requests[0]?.headers.has("User-Agent")).toBe(false);
	});

	it("does not disturb the Authorization header", async () => {
		const { neon, requests } = neonRecording("my-cli/1.2.0");

		await neon.projects.get("p-1");

		expect(requests[0]?.headers.get("Authorization")).toBe("Bearer test");
	});
});
