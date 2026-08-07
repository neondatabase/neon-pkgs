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

	// Specifiers are kept whole rather than reduced to their package. A package may export
	// only a subpath, in which case importing the root throws and a trace of it finds
	// nothing — so the trace has to import exactly what was authored. Reducing to the package
	// is the caller's job, via `externalPackageRoot`, and only to decide what to install.
	test("keeps a subpath specifier as authored", () => {
		expect(
			packagesToStage([
				{ name: "sharp/lib/index.js", includeFiles: true },
			]),
		).toEqual(["sharp/lib/index.js"]);
	});

	test("keeps a bare name and a subpath of it as two specifiers", () => {
		expect(
			packagesToStage([
				{ name: "sharp", includeFiles: true },
				{ name: "sharp/lib/index.js", includeFiles: true },
			]),
		).toEqual(["sharp", "sharp/lib/index.js"]);
	});

	test("deduplicates an exactly repeated specifier", () => {
		expect(
			packagesToStage([
				{ name: "sharp", includeFiles: true },
				{ name: "sharp", includeFiles: true },
			]),
		).toEqual(["sharp"]);
	});
});
