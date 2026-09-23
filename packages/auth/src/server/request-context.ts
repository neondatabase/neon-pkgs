/**
 * Header name used to identify server-side proxy requests.
 * The value will be the framework name (e.g. 'nextjs', 'tanstack-start', 'hono').
 *
 * Adapter authors should not set this header themselves; it is set
 * automatically by {@link createAuthServer} based on
 * {@link RequestContext.getFramework}.
 *
 * @public
 */
export const NEON_AUTH_SERVER_PROXY_HEADER = "x-neon-auth-proxy";

/**
 * Framework-agnostic interface for accessing per-request cookies, headers,
 * and origin. Implement this for each server framework you want to support
 * (Next.js, TanStack Start, Hono, Express, Remix, SolidStart, etc.).
 *
 * The toolkit calls these methods on each invocation of a server method
 * returned by {@link createAuthServer} (e.g. `auth.getSession()`,
 * `auth.signIn.email(...)`). Adapters MAY use `AsyncLocalStorage` or a
 * per-request bound instance — the toolkit treats this as an opaque factory.
 *
 * @example Next.js (via `next/headers`)
 * ```ts
 * async function createNextRequestContext(): Promise<RequestContext> {
 *   const headerStore = await headers();
 *   const cookieStore = await cookies();
 *   return {
 *     getCookies: () => extractNeonAuthCookies(headerStore),
 *     setCookie: (name, value, options) => cookieStore.set(name, value, options),
 *     getHeader: (name) => headerStore.get(name) ?? null,
 *     getOrigin: () => headerStore.get('origin') ?? '',
 *     getFramework: () => 'nextjs',
 *   };
 * }
 * ```
 *
 * @example Hono (via `hono/context-storage`)
 * ```ts
 * function createHonoRequestContext(): RequestContext {
 *   const c = getContext();
 *   return {
 *     getCookies: () => c.req.header('cookie') ?? '',
 *     setCookie: (name, value, options) => setCookie(c, name, value, options),
 *     getHeader: (name) => c.req.header(name) ?? null,
 *     getOrigin: () => c.req.header('origin') ?? '',
 *     getFramework: () => 'hono',
 *   };
 * }
 * ```
 *
 * @public
 */
export interface RequestContext {
	/**
	 * Return cookies on the incoming request as a single `Cookie:` header value
	 * (e.g. `"name1=value1; name2=value2"`).
	 *
	 * Adapters MAY pre-filter to cookies prefixed with `NEON_AUTH_COOKIE_PREFIX`
	 * for efficiency using {@link extractNeonAuthCookies}; the toolkit also
	 * accepts the unfiltered header.
	 *
	 * Called once per server method invocation. Implementations MUST NOT throw;
	 * return an empty string if no cookies are present.
	 */
	getCookies(): Promise<string> | string;

	/**
	 * Persist a `Set-Cookie` for the current response.
	 *
	 * Called zero or more times per server method invocation when the upstream
	 * Neon Auth response includes `Set-Cookie` headers (e.g. after sign-in or
	 * session refresh). Each call corresponds to one cookie; do not coalesce.
	 *
	 * The toolkit pre-sanitizes upstream cookie flags before calling this
	 * method (strips `Partitioned`, applies the configured `SameSite`,
	 * applies the configured `domain`). Adapters should pass the supplied
	 * options through verbatim.
	 *
	 * Implementations MAY be async if the framework's cookie API is async
	 * (e.g. Next.js `cookies()` returns a Promise in App Router).
	 */
	setCookie(
		name: string,
		value: string,
		options: CookieOptions,
	): Promise<void> | void;

	/**
	 * Read a single request header by name. Names are case-insensitive per
	 * the HTTP spec; implementations MUST normalize lookups (or rely on
	 * a framework API that already does).
	 *
	 * Return `null` (not `undefined`) when the header is absent.
	 */
	getHeader(name: string): Promise<string | null> | string | null;

	/**
	 * Return the origin of the incoming request as an absolute URL string
	 * (e.g. `"https://app.example.com"`). Used as the `Origin` header when
	 * proxying upstream so the auth server can enforce CORS / trusted-origin
	 * policies.
	 *
	 * Implementations typically prefer the `Origin` header, falling back to
	 * the first three path segments of `Referer`. Return an empty string when
	 * neither is available — the toolkit will surface an upstream error rather
	 * than crash.
	 */
	getOrigin(): Promise<string> | string;

	/**
	 * Return a stable identifier for the framework hosting this adapter
	 * (e.g. `'nextjs'`, `'tanstack-start'`, `'hono'`, `'remix'`).
	 *
	 * Sent upstream as the {@link NEON_AUTH_SERVER_PROXY_HEADER} value so the
	 * Neon Auth server can attribute requests to specific framework adapters
	 * for telemetry and request routing.
	 */
	getFramework(): string;
}

/**
 * Cookie attributes supported by {@link RequestContext.setCookie}.
 *
 * Mirrors the subset of standard cookie attributes the toolkit emits. Adapter
 * implementations should map these into their framework's native cookie API.
 *
 * @public
 */
export interface CookieOptions {
	maxAge?: number;
	expires?: Date;
	path?: string;
	domain?: string;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: "strict" | "lax" | "none";
	partitioned?: boolean;
}

/**
 * Factory that yields a fresh {@link RequestContext} for the in-flight request.
 *
 * Called by {@link createAuthServer} on every server method invocation, so
 * implementations should be lightweight. Adapters typically capture per-request
 * state via `AsyncLocalStorage` (Next.js `next/headers`, Hono
 * `contextStorage`, TanStack Start `getRequest`) and surface it through this
 * factory.
 *
 * MAY return a `Promise` if the framework's request-scoped APIs are async
 * (e.g. Next.js `headers()` / `cookies()` in App Router).
 *
 * @public
 */
export type RequestContextFactory = () =>
	| RequestContext
	| Promise<RequestContext>;
