import { describe, expect, test } from "vitest";
import {
	externalPackageRoot,
	normalizeExternalPackage,
	packagesToStage,
} from "./external-packages.js";

describe("externalPackageRoot", () => {
	test("returns a bare name unchanged", () => {
		expect(externalPackageRoot("sharp")).toBe("sharp");
	});

	test("keeps both segments of a scoped name", () => {
		expect(externalPackageRoot("@img/sharp-linux-arm64")).toBe(
			"@img/sharp-linux-arm64",
		);
	});

	test("drops a subpath", () => {
		expect(externalPackageRoot("sharp/lib/index.js")).toBe("sharp");
	});

	test("drops a subpath under a scope", () => {
		expect(externalPackageRoot("@scope/pkg/sub/deep.js")).toBe(
			"@scope/pkg",
		);
	});
});

describe("normalizeExternalPackage", () => {
	test("defaults a bare string to shipping its files", () => {
		expect(normalizeExternalPackage("sharp")).toEqual({
			name: "sharp",
			includeFiles: true,
		});
	});

	test("defaults the object form to shipping its files", () => {
		expect(normalizeExternalPackage({ name: "sharp" })).toEqual({
			name: "sharp",
			includeFiles: true,
		});
	});

	test("carries includeFiles: false through", () => {
		expect(
			normalizeExternalPackage({ name: "canvas", includeFiles: false }),
		).toEqual({ name: "canvas", includeFiles: false });
	});
});

describe("packagesToStage", () => {
	test("returns the packages that ship, in declaration order", () => {
		expect(
			packagesToStage([
				{ name: "sharp", includeFiles: true },
				{ name: "@napi-rs/canvas", includeFiles: true },
			]),
		).toEqual(["sharp", "@napi-rs/canvas"]);
	});

	test("omits packages that opted out", () => {
		expect(
			packagesToStage([
				{ name: "sharp", includeFiles: true },
				{ name: "canvas", includeFiles: false },
			]),
		).toEqual(["sharp"]);
	});

	test("is empty when every entry opted out, so nothing is staged", () => {
		expect(
			packagesToStage([{ name: "microsandbox", includeFiles: false }]),
		).toEqual([]);
	});

	test("collapses a subpath onto its package", () => {
		expect(
			packagesToStage([
				{ name: "sharp/lib/index.js", includeFiles: true },
			]),
		).toEqual(["sharp"]);
	});

	test("stages a package once when named both bare and through a subpath", () => {
		expect(
			packagesToStage([
				{ name: "sharp", includeFiles: true },
				{ name: "sharp/lib/index.js", includeFiles: true },
			]),
		).toEqual(["sharp"]);
	});
});
