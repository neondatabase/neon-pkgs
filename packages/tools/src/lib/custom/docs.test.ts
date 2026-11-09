import { describe, expect, test } from "vitest";
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
