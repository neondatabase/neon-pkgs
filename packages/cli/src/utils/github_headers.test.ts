import { describe, expect, it } from "vitest";
import { githubRequestHeaders } from "./github_headers";

describe("githubRequestHeaders", () => {
	it("sends GITHUB_TOKEN or GH_TOKEN to GitHub's own hosts", () => {
		expect(
			githubRequestHeaders(
				"https://raw.githubusercontent.com/a/b/HEAD/x",
				{
					GITHUB_TOKEN: "t1",
				},
			),
		).toEqual({ "User-Agent": "neon", Authorization: "Bearer t1" });
		expect(
			githubRequestHeaders(
				"https://codeload.github.com/a/b/tar.gz/main",
				{
					GH_TOKEN: "t2",
				},
			),
		).toMatchObject({ Authorization: "Bearer t2" });
	});

	it("never sends the token anywhere else", () => {
		for (const url of [
			"https://neon.com/bootstrap/templates.yaml",
			"https://mirror.example.com/raw",
			"http://127.0.0.1:9/",
			"http://raw.githubusercontent.com/a/b/HEAD/x",
			"https://raw.githubusercontent.com.evil.example/a",
		]) {
			expect(githubRequestHeaders(url, { GITHUB_TOKEN: "t1" })).toEqual({
				"User-Agent": "neon",
			});
		}
	});

	it("omits Authorization without a token", () => {
		expect(
			githubRequestHeaders("https://api.github.com/repos/a/b", {}),
		).toEqual({ "User-Agent": "neon" });
	});
});
