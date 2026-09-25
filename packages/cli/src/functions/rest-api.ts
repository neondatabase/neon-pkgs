import type { BuiltinTemplate } from "./registry.js";

const NOTES_SOURCE = `type Note = { id: number; title: string };

const notes: Note[] = [
	{ id: 1, title: "First note" },
	{ id: 2, title: "Second note" },
];

const handler = async (request: Request): Promise<Response> => {
	if (request.method === "GET") {
		return Response.json({ notes });
	}

	if (request.method === "POST") {
		const body = (await request.json().catch(() => null)) as {
			title?: unknown;
		} | null;
		if (!body || typeof body.title !== "string") {
			return Response.json(
				{ error: "Expected a JSON body with a string title." },
				{ status: 400 },
			);
		}
		const created: Note = { id: notes.length + 1, title: body.title };
		return Response.json({ note: created }, { status: 201 });
	}

	return Response.json({ error: "Method not allowed" }, { status: 405 });
};

export default { fetch: handler };
`;

const NOTE_SOURCE = `type Note = { id: number; title: string };

const notes: Note[] = [
	{ id: 1, title: "First note" },
	{ id: 2, title: "Second note" },
];

const handler = async (request: Request): Promise<Response> => {
	if (request.method !== "GET") {
		return Response.json({ error: "Method not allowed" }, { status: 405 });
	}

	const id = Number(new URL(request.url).searchParams.get("id"));
	const note = notes.find((entry) => entry.id === id);
	if (!note) {
		return Response.json({ error: "Note not found" }, { status: 404 });
	}

	return Response.json({ note });
};

export default { fetch: handler };
`;

const HEALTH_SOURCE = `const handler = async (_request: Request): Promise<Response> => {
	return Response.json({ status: "ok" });
};

export default { fetch: handler };
`;

export const REST_API_TEMPLATE: BuiltinTemplate = {
	template: {
		id: "rest-api",
		provider: "Neon",
		title: "REST API",
		description:
			"A minimal, dependency-free REST API on Neon Functions with routed endpoints.",
		layout: "router",
		dependencies: [],
		environment: [],
		operations: [
			{
				id: "notes",
				title: "List and create notes",
				description:
					"GET returns the notes; POST creates one from a JSON body.",
				source: "functions/notes.ts",
				route: "/notes",
				recommended: true,
			},
			{
				id: "note",
				title: "Get a note by id",
				description: "GET a single note with ?id=<number>.",
				source: "functions/note.ts",
				route: "/note",
				recommended: true,
			},
			{
				id: "health",
				title: "Health check",
				description: "GET returns a simple status payload.",
				source: "functions/health.ts",
				route: "/health",
				recommended: true,
			},
		],
	},
	sources: {
		"functions/notes.ts": NOTES_SOURCE,
		"functions/note.ts": NOTE_SOURCE,
		"functions/health.ts": HEALTH_SOURCE,
	},
};
