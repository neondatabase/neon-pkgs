import type { BuiltinTemplate } from "./registry.js";

const BASIC_SOURCE = `export default {
	async fetch(request: Request): Promise<Response> {
		return Response.json({
			message: "Hello from Neon Functions!",
			method: request.method,
		});
	},
};
`;

export const BASIC_TEMPLATE: BuiltinTemplate = {
	template: {
		id: "basic",
		provider: "Neon",
		title: "Basic function",
		description: "A minimal Neon Function with a JSON response.",
		layout: "router",
		dependencies: [],
		environment: [],
	},
	sources: {
		"functions/index.ts": BASIC_SOURCE,
	},
};
