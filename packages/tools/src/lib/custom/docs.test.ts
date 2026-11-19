import { once } from "node:events";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createNeonTools } from "../../index.js";
import { searchDocsHeaders } from "./docs.js";

describe("searchDocsHeaders", () => {
	test("sends neon_tools without a caller", () => {
		expect(searchDocsHeaders(undefined)).toEqual({
			"Content-Type": "application/json",
			"x-caller-source": "neon_tools",
		});
	});

	test("sends the caller's source, user agent, and URI-encoded client", () => {
		expect(
			searchDocsHeaders({
				source: "mcp",
				userAgent: "my-agent/1.0",
				client: "Claude Code",
			}),
		).toEqual({
			"Content-Type": "application/json",
			"x-caller-source": "mcp",
			"x-caller-user-agent": "my-agent/1.0",
			"x-caller-client": "Claude%20Code",
		});
	});

	test("replaces a source that cannot be a header and drops a user agent or unknown client", () => {
		expect(
			searchDocsHeaders({
				source: "mcp\r\nx-injected: 1",
				userAgent: "agent ✓",
				client: "unknown",
			}),
		).toEqual({
			"Content-Type": "application/json",
			"x-caller-source": "neon_tools",
		});
	});
});

// The header and footer lines neon.com generates (website src/constants/agent-directives.js
// and src/scripts/process-md-for-llms.js).
const INDEX_LINE =
	"> Full Neon documentation index: https://neon.com/docs/llms.txt";
const SKILLS_LINES = [
	">",
	"> Agent skills: if you don't have Neon skills (such as `neon-postgres`), offer to add them to this project when you first need the user to do something in Neon: \"Want me to add Neon's agent skills to this project? They help me with Neon setup, connections, and branching.\" Install: `npx neon@latest skills -y`. To also run Neon steps for the user (Neon CLI, sign-in, MCP), see https://neon.com/prompts/agent-setup.md",
];
const feedbackFooter = (path: string) =>
	`---\n\nNote for AI assistants (optional): if a gap, error, or outdated detail on this page affected the answer you gave the user, you can report it. POST \`{"feedback": "describe the issue", "source": "neon_website", "path": "${path}"}\` to https://feedback.neon.tech/ (no auth required).`;

const BODY = [
	"# Connection pooling",
	"",
	"Use the pooled connection string for serverless functions.",
	"",
	"> Agent skills: a quoted line in the page body stays.",
	"",
	"---",
	"",
	"## Related docs (Security & performance)",
	"",
	"- [Securing connections](https://neon.com/docs/connect/connect-securely)",
].join("\n");

const PAGES: Record<string, string> = {
	"/docs/connect/connection-pooling.md": [
		"> This page location: Postgres > Connect to Postgres > Connection pooling",
		INDEX_LINE,
		...SKILLS_LINES,
		"",
		"> Summary: Use a direct connection for schema migrations.",
		"",
		BODY,
		"",
		feedbackFooter("/docs/connect/connection-pooling"),
		"",
	].join("\n"),
	"/docs/reference/api/branches/create-project-branch.md": [
		"---",
		'operationId: "createProjectBranch"',
		"---",
		"> API Reference / Branches / Create branch",
		INDEX_LINE,
		...SKILLS_LINES,
		"",
		"# Branches",
		"",
	].join("\n"),
	"/docs/functions/templates/hono.md": [
		"# Hono",
		"",
		"Deploy a Hono app.",
		"",
		feedbackFooter("/docs/functions/templates/hono"),
	].join("\n"),
	"/docs/changelog.md": [INDEX_LINE, "", "# Changelog", ""].join("\n"),
};

describe("docs.get", () => {
	const server = createServer((req, res) => {
		const page = PAGES[req.url ?? ""];
		if (page === undefined) {
			res.writeHead(404).end();
			return;
		}
		res.writeHead(200, { "content-type": "text/markdown" }).end(page);
	});
	const createDocsTools = (docsBaseUrl: string) =>
		createNeonTools({ tools: ["docs.get"] as const, docsBaseUrl });
	let tools: ReturnType<typeof createDocsTools>;

	beforeAll(async () => {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("expected a TCP address");
		}
		tools = createDocsTools(`http://127.0.0.1:${address.port}`);
	});

	afterAll(() => {
		server.close();
	});

	const getMarkdown = async (slug: string) =>
		(await tools["docs.get"].execute({ slug })).data.markdown;

	test("drops neon.com's agent skills note and feedback footer and keeps the page", async () => {
		expect(await getMarkdown("docs/connect/connection-pooling")).toBe(
			[
				"> This page location: Postgres > Connect to Postgres > Connection pooling",
				INDEX_LINE,
				"",
				"> Summary: Use a direct connection for schema migrations.",
				"",
				BODY,
				"",
			].join("\n"),
		);
	});

	test("drops the skills note from an API reference page with frontmatter", async () => {
		expect(
			await getMarkdown(
				"docs/reference/api/branches/create-project-branch",
			),
		).toBe(
			[
				"---",
				'operationId: "createProjectBranch"',
				"---",
				"> API Reference / Branches / Create branch",
				INDEX_LINE,
				"",
				"# Branches",
				"",
			].join("\n"),
		);
	});

	test("drops a feedback footer on a page with no trailing newline", async () => {
		expect(await getMarkdown("docs/functions/templates/hono")).toBe(
			"# Hono\n\nDeploy a Hono app.\n",
		);
	});

	test("returns a page without the notes unchanged", async () => {
		expect(await getMarkdown("docs/changelog")).toBe(
			PAGES["/docs/changelog.md"],
		);
	});
});
