/**
 * Type tests for the `@neon/neon-js/supabase` entry, whose `createClient` has the
 * Supabase adapter fixed. Run with `vitest --typecheck`.
 */

import { describe, expectTypeOf, it } from "vitest";
import { createClient } from "../supabase";

describe("supabase createClient — object form", () => {
	const client = createClient({
		auth: { url: "https://auth.example.com" },
		dataApi: { url: "https://data-api.example.com/rest/v1" },
	});

	it("exposes the Supabase-compatible auth API", () => {
		expectTypeOf(client.auth.getSession).toBeFunction();
		expectTypeOf(client.auth.getJWTToken).toBeFunction();
		expectTypeOf(client.auth.signInWithPassword).toBeFunction();
		expectTypeOf(client.auth.signUp).toBeFunction();
		expectTypeOf(client.auth.signOut).toBeFunction();
	});

	it("exposes Data API query methods", () => {
		expectTypeOf(client.from).toBeFunction();
	});

	it("does not take an adapter", () => {
		// @ts-expect-error the adapter is fixed to SupabaseAuthAdapter
		createClient({
			auth: { url: "https://auth.example.com", adapter: () => undefined },
			dataApi: { url: "https://data-api.example.com/rest/v1" },
		});
	});
});

describe("supabase createClient — adapter options", () => {
	const dataApi = { url: "https://data-api.example.com/rest/v1" };

	it("accepts fetchOptions and sessionOptions in the object form", () => {
		createClient({
			auth: {
				url: "https://auth.example.com",
				fetchOptions: { headers: { Cookie: "a=b" } },
				sessionOptions: { refetchOnWindowFocus: false },
			},
			dataApi,
		});
	});

	it("accepts fetchOptions and sessionOptions in the string form", () => {
		createClient("https://ep-xxx.c-2.us-east-2.aws.neon.build/db", {
			auth: {
				fetchOptions: { headers: { Cookie: "a=b" } },
				sessionOptions: { refetchOnWindowFocus: false },
			},
		});
	});

	it("rejects unknown auth keys", () => {
		// @ts-expect-error not an adapter option
		createClient({
			auth: { url: "https://auth.example.com", notAnOption: true },
			dataApi,
		});
		createClient("https://ep-xxx.c-2.us-east-2.aws.neon.build/db", {
			// @ts-expect-error not an adapter option
			auth: { notAnOption: true },
		});
	});
});

describe("supabase createClient — string form", () => {
	const client = createClient(
		"https://ep-xxx.c-2.us-east-2.aws.neon.build/db",
	);

	it("exposes the Supabase-compatible auth API", () => {
		expectTypeOf(client.auth.signInWithPassword).toBeFunction();
		expectTypeOf(client.auth.signUp).toBeFunction();
		expectTypeOf(client.auth.signOut).toBeFunction();
	});

	it("accepts overrides without an adapter", () => {
		createClient("https://ep-xxx.c-2.us-east-2.aws.neon.build/db", {
			auth: { allowAnonymous: true },
		});
	});
});

describe("supabase createClient — Database type parameter", () => {
	interface TestDatabase {
		public: {
			Tables: {
				users: {
					Row: { id: number; name: string };
					Insert: { id?: number; name: string };
					Update: { id?: number; name?: string };
				};
			};
			Views: Record<string, never>;
			Functions: Record<string, never>;
		};
	}

	it("keeps the Supabase auth API in the object form", () => {
		const typed = createClient<TestDatabase>({
			auth: { url: "https://auth.example.com" },
			dataApi: { url: "https://data-api.example.com/rest/v1" },
		});
		expectTypeOf(typed.auth.signInWithPassword).toBeFunction();
	});

	it("keeps the Supabase auth API in the string form", () => {
		const typed = createClient<TestDatabase>(
			"https://ep-xxx.c-2.us-east-2.aws.neon.build/db",
		);
		expectTypeOf(typed.auth.signInWithPassword).toBeFunction();
	});
});
