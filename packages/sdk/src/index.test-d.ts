import { expectTypeOf, test } from "vitest";
import type * as sdk from "./index.js";
import type { Client, Project } from "./index.js";
import type { Config, RawResult } from "./raw.js";

test("schema types and Client stay on the main entry", () => {
	expectTypeOf<Project>().toMatchTypeOf<object>();
	expectTypeOf<Client>().toMatchTypeOf<object>();
});

test("raw plumbing types are not on the main entry", () => {
	// @ts-expect-error RawResult is exported from @neon/sdk/raw, not @neon/sdk
	type _RawResult = sdk.RawResult;
	// @ts-expect-error Config is exported from @neon/sdk/raw, not @neon/sdk
	type _Config = sdk.Config;
	// @ts-expect-error RawOptions is exported from @neon/sdk/raw, not @neon/sdk
	type _RawOptions = sdk.RawOptions;
});

test("raw plumbing types remain on the raw entry", () => {
	expectTypeOf<RawResult<{ id: string }>>().toMatchTypeOf<
		| { data: { id: string }; error: undefined }
		| { data: undefined; error: unknown }
	>();
	expectTypeOf<Config>().toMatchTypeOf<object>();
});
