import { TooManyEmbeddingValuesForCallError } from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";
import {
	startTestGateway,
	type TestGateway,
} from "../../test/gateway-server.js";
import { NEON_MAX_EMBEDDINGS_PER_CALL } from "./neon-embedding-options.js";
import { createNeon } from "./provider.js";

describe("neon.embeddingModel", () => {
	let gateway: TestGateway | undefined;

	afterEach(async () => {
		await gateway?.close();
		gateway = undefined;
	});

	it("builds a v3 embedding model without resolving configuration", () => {
		const model = createNeon().embeddingModel("qwen3-embedding-0-6b");
		expect(model.specificationVersion).toBe("v3");
		expect(model.provider).toBe("neon.embedding");
		expect(model.modelId).toBe("qwen3-embedding-0-6b");
		expect(model.maxEmbeddingsPerCall).toBe(NEON_MAX_EMBEDDINGS_PER_CALL);
	});

	it("keeps textEmbeddingModel as an alias", () => {
		const model = createNeon().textEmbeddingModel("gte-large-en");
		expect(model.provider).toBe("neon.embedding");
		expect(model.modelId).toBe("gte-large-en");
	});

	it("rejects more inputs than the gateway accepts before sending a request", async () => {
		gateway = await startTestGateway({ body: { data: [] } });
		const model = createNeon({
			baseURL: gateway.baseURL,
			apiKey: "test-token",
		}).embeddingModel("qwen3-embedding-0-6b");
		const values = Array.from(
			{ length: NEON_MAX_EMBEDDINGS_PER_CALL + 1 },
			(_, index) => `text ${index}`,
		);

		await expect(model.doEmbed({ values })).rejects.toBeInstanceOf(
			TooManyEmbeddingValuesForCallError,
		);
		expect(gateway.requests).toHaveLength(0);
	});
});
