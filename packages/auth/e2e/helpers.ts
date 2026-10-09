/**
 * Values the global setup published for this run. Read through helpers rather than
 * `process.env` at each call site so the not-provisioned failure has one clear message
 * instead of a `TypeError: cannot read property of undefined` deep inside a test.
 */
export function requiredAuthEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(
			`${name} is not set. The e2e global setup should have provisioned it from ` +
				"NEON_API_KEY — if it is missing, the run was started with --config instead of " +
				"vitest.e2e.config.ts, or setup failed.",
		);
	}
	return value;
}

export function authBaseUrl(): string {
	return requiredAuthEnv("NEON_AUTH_BASE_URL");
}

export function jwksUrl(): string {
	return requiredAuthEnv("NEON_AUTH_JWKS_URL");
}

/** Unique per run and per call: two signups in the same millisecond stay distinct. */
export function uniqueEmail(prefix = "auth-e2e"): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(7)}@example.com`;
}

/** The password every throwaway account gets. Meets better-auth's minimum length. */
export const TEST_PASSWORD = "TestPassword123!";

/**
 * The `Origin` every request carries. Node's fetch sends none, and the service rejects a
 * relative `callbackURL` without one (400 `bad_oauth_callback`); the provisioning trusts
 * localhost origins so this one is accepted.
 */
export const ORIGIN = "http://localhost:3000";

/** What the cookie jar saw on one response: the facts no adapter exposes to a test. */
export interface RecordedResponse {
	url: string;
	setCookies: string[];
	/** The `set-auth-jwt` header the JWT handshake rides on, or null when absent. */
	authJwt: string | null;
}

export interface CookieFetch {
	/** Every response seen while the jar was installed, in order. */
	recorded: RecordedResponse[];
	restore: () => void;
}

/**
 * Node's fetch keeps no cookie state, and the adapter's requests ride the global `fetch`
 * (`adapter-core.ts` builds its own `customFetchImpl` around it, overwriting any
 * user-supplied one), so the jar installs itself as `globalThis.fetch`: it attaches stored
 * cookies on the way out and records `Set-Cookie` + `set-auth-jwt` on the way back.
 *
 * The recording is the only way a test can see the raw cookie attributes — the adapter
 * consumes the response long before an assertion could.
 */
export function installCookieFetch(): CookieFetch {
	// `hostname|cookieName` → `name=value`; per-host so a redirect elsewhere can't leak them.
	const jar = new Map<string, string>();
	const recorded: RecordedResponse[] = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = async (input, init) => {
		const url =
			input instanceof URL
				? input
				: new URL(typeof input === "string" ? input : input.url);
		const headers = new Headers(
			init?.headers ??
				(input instanceof Request ? input.headers : undefined),
		);
		const stored = [...jar.entries()]
			.filter(([key]) => key.startsWith(`${url.hostname}|`))
			.map(([, cookie]) => cookie);
		if (!headers.has("origin")) headers.set("origin", ORIGIN);
		if (stored.length > 0 && !headers.has("cookie")) {
			headers.set("cookie", stored.join("; "));
		}
		const response = await originalFetch(input, { ...init, headers });
		const setCookies = response.headers.getSetCookie();
		recorded.push({
			url: url.toString(),
			setCookies,
			authJwt: response.headers.get("set-auth-jwt"),
		});
		for (const setCookie of setCookies) {
			const [pair] = setCookie.split(";");
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const name = pair.slice(0, eq).trim();
			jar.set(`${url.hostname}|${name}`, pair.trim());
		}
		return response;
	};

	return {
		recorded,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}
