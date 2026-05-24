import { describe, expect, test } from "vitest";
import { formatConfigAsJson, formatInitTemplate } from "./format.js";

const pulled = {
	project: {
		id: "proj",
		name: "app",
		region: "aws-us-east-1",
		pgVersion: 17,
	},
	branch: { id: "br-main", name: "main", isDefault: true, protected: true },
	config: { protected: true, auth: { enabled: true } },
};

describe("formatInitTemplate", () => {
	test("renders a branch-policy neon.ts", () => {
		const out = formatInitTemplate(pulled);
		expect(out).toContain("defineConfig((branch) =>");
		expect(out).toContain('branch.name === "main"');
		expect(out).toContain('parent: "main"');
	});
});

describe("formatConfigAsJson", () => {
	test("prints pulled state as json", () => {
		expect(JSON.parse(formatConfigAsJson(pulled)).branch.name).toBe("main");
	});
});
