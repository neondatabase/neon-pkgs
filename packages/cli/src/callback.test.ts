import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const callbackPage = readFileSync(
	new URL("./callback.html", import.meta.url),
	"utf8",
);

describe("the post-auth callback page", () => {
	it("recommends Neon agent tooling", () => {
		expect(callbackPage).toContain("Build with your favorite AI agent");
		expect(callbackPage).toContain(
			"Paste into any AI coding agent to install Neon agent tooling:",
		);
		expect(callbackPage).toContain(
			"Fetch the Neon skill from https://neon.com/.well-known/agent-skills/neon/SKILL.md",
		);
		expect(callbackPage).toContain(
			"Check whether Neon agent skills and the Neon MCP server are already installed",
		);
	});

	it("shows supported coding-agent icons on the copy action", () => {
		for (const agent of [
			"claude-code",
			"codex",
			"cursor",
			"github-copilot",
		]) {
			expect(callbackPage).toContain(`data-agent="${agent}"`);
		}
	});

	it("provides an accessible copy-prompt action", () => {
		expect(callbackPage).toContain('id="copy-prompt"');
		expect(callbackPage).toContain(
			'class="agent-icons" aria-hidden="true"',
		);
		expect(callbackPage).toContain(
			'class="copy-status" id="copy-status" role="status"',
		);
		expect(callbackPage).toContain("navigator.clipboard.writeText(prompt)");
		expect(callbackPage).toContain("copyWithFallback(prompt)");
	});
});
