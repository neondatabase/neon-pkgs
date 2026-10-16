/**
 * Type tests for createClient
 * Run with: vitest --typecheck or pnpm test:types
 *
 * These tests verify that TypeScript correctly infers types based on the adapter.
 */

import { BetterAuthReactAdapter } from "@neon/auth/react/adapters";
import {
	BetterAuthVanillaAdapter,
	SupabaseAuthAdapter,
} from "@neon/auth/vanilla/adapters";
import { describe, expectTypeOf, it } from "vitest";
import { createClient } from "../client/client-factory";

// =============================================================================
// Test 2: BetterAuthVanillaAdapter - should expose Better Auth API directly
// =============================================================================
describe("BetterAuthVanillaAdapter type inference", () => {
	const vanillaClient = createClient({
		auth: {
			adapter: BetterAuthVanillaAdapter(),
			url: "https://auth.example.com",
		},
		dataApi: {
			url: "https://data-api.example.com/rest/v1",
		},
	});

	it("should have signIn.email method", () => {
		expectTypeOf(vanillaClient.auth.signIn.email).toBeFunction();
	});

	it("should have signUp.email method", () => {
		expectTypeOf(vanillaClient.auth.signUp.email).toBeFunction();
	});

	it("should have getSession method", () => {
		expectTypeOf(vanillaClient.auth.getSession).toBeFunction();
	});

	it("should have signOut method", () => {
		expectTypeOf(vanillaClient.auth.signOut).toBeFunction();
	});
});

// =============================================================================
// Test 3: BetterAuthReactAdapter - should expose Better Auth API with hooks
// =============================================================================
describe("BetterAuthReactAdapter type inference", () => {
	const reactClient = createClient({
		auth: {
			adapter: BetterAuthReactAdapter(),
			url: "https://auth.example.com",
		},
		dataApi: {
			url: "https://data-api.example.com/rest/v1",
		},
	});

	it("should have signIn.email method", () => {
		expectTypeOf(reactClient.auth.signIn.email).toBeFunction();
	});

	it("should have signUp.email method", () => {
		expectTypeOf(reactClient.auth.signUp.email).toBeFunction();
	});

	it("should have getSession method", () => {
		expectTypeOf(reactClient.auth.getSession).toBeFunction();
	});

	it("should have useSession hook", () => {
		expectTypeOf(reactClient.auth.useSession).toBeFunction();
	});
});

// =============================================================================
// Test 4: Default adapter (no adapter specified)
// =============================================================================
describe("Default adapter type inference", () => {
	const defaultClient = createClient({
		auth: {
			url: "https://auth.example.com",
		},
		dataApi: {
			url: "https://data-api.example.com/rest/v1",
		},
	});

	it("should default to BetterAuthVanillaAdapter API", () => {
		expectTypeOf(defaultClient.auth.signIn.email).toBeFunction();
	});

	it("should have getSession method", () => {
		expectTypeOf(defaultClient.auth.getSession).toBeFunction();
	});
});

// =============================================================================
// Test 5: Database type parameter with adapter inference
// =============================================================================
describe("Database type parameter with adapter inference", () => {
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

	it("should infer BetterAuthVanillaAdapter API when Database type is provided", () => {
		const typedClient = createClient<TestDatabase>({
			auth: {
				adapter: BetterAuthVanillaAdapter(),
				url: "https://auth.example.com",
			},
			dataApi: {
				url: "https://data-api.example.com/rest/v1",
			},
		});

		expectTypeOf(typedClient.auth.signIn.email).toBeFunction();
	});
});

// =============================================================================
// Test 6: String form — default adapter
// =============================================================================
describe("String form — default adapter type inference", () => {
	const client = createClient(
		"https://ep-xxx.c-2.us-east-2.aws.neon.build/db",
	);

	it("should default to BetterAuthVanillaAdapter API", () => {
		expectTypeOf(client.auth.signIn.email).toBeFunction();
		expectTypeOf(client.auth.getSession).toBeFunction();
	});
});

// =============================================================================
// Test 8: String form — explicit BetterAuthReactAdapter
// =============================================================================
describe("String form — BetterAuthReactAdapter type inference", () => {
	const client = createClient(
		"https://ep-xxx.c-2.us-east-2.aws.neon.build/db",
		{
			auth: { adapter: BetterAuthReactAdapter() },
		},
	);

	it("should expose React adapter API", () => {
		expectTypeOf(client.auth.useSession).toBeFunction();
		expectTypeOf(client.auth.signIn.email).toBeFunction();
	});
});

// =============================================================================
// Test 9: String form — Database type parameter
// =============================================================================
describe("String form with Database type parameter", () => {
	interface TestDatabaseStringForm {
		public: {
			Tables: {
				items: {
					Row: { id: number };
					Insert: { id?: number };
					Update: { id?: number };
				};
			};
			Views: Record<string, never>;
			Functions: Record<string, never>;
		};
	}

	it("should preserve Database type with default adapter", () => {
		const typed = createClient<TestDatabaseStringForm>(
			"https://ep-xxx.c-2.us-east-2.aws.neon.build/db",
		);
		expectTypeOf(typed.auth.signIn.email).toBeFunction();
	});
});

// =============================================================================
// Test 10: External auth provider form — queries work, no `.auth` property
// =============================================================================
describe("External auth provider form type inference", () => {
	const client = createClient({
		dataApi: {
			url: "https://data-api.example.com/rest/v1",
			getToken: async () => "token",
		},
	});

	it("should expose Data API query methods", () => {
		expectTypeOf(client.from).toBeFunction();
	});

	it("should not expose an `auth` property", () => {
		expectTypeOf(client).not.toHaveProperty("auth");
	});
});

// =============================================================================
// Test 11: The Supabase adapter is not accepted by the main entry
// =============================================================================
describe("Supabase adapter is rejected by the main createClient", () => {
	it("rejects the object form", () => {
		// @ts-expect-error the Supabase-compatible client lives at `@neon/neon-js/supabase`
		createClient({
			auth: {
				adapter: SupabaseAuthAdapter(),
				url: "https://auth.example.com",
			},
			dataApi: { url: "https://data-api.example.com/rest/v1" },
		});
	});

	it("rejects the string form", () => {
		createClient("https://ep-xxx.c-2.us-east-2.aws.neon.build/db", {
			// @ts-expect-error the Supabase-compatible client lives at `@neon/neon-js/supabase`
			auth: { adapter: SupabaseAuthAdapter() },
		});
	});
});
