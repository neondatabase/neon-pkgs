/**
 * Pure function: given a Neon base URL, returns the corresponding
 * auth and Data API URLs.
 *
 * Wrappers (e.g. @databricks/lakebase-js) can supply a different implementation
 * via the `deriveUrls` option on createClient.
 */
export type DeriveNeonUrls = (baseUrl: string) => {
	auth: string;
	dataApi: string;
};

/**
 * Default URL derivation for Neon endpoints.
 *
 * Insert `neonauth` / `apirest` after the first hostname label and append
 * `/auth` / `/rest/v1` to the path.
 *
 * Only the protocol, host, port, and path are used. A query string, hash
 * fragment, or embedded credentials (`user:pass@host`) are rejected.
 *
 * Constraints (use the object form or a custom `deriveUrls` to bypass them):
 *   - The hostname must have at least 3 dot-separated labels, so `localhost`
 *     and single-host proxies are intentionally rejected.
 *   - A single port is applied to both derived hosts, so split-port local
 *     setups (e.g. `neonauth:30443` vs `apirest:9443`) cannot be expressed
 *     via the string form. In production both services share port 443.
 *
 * Example:
 *   https://ep-xxx.c-2.us-east-2.aws.neon.build/dbname
 *     → auth:    https://ep-xxx.neonauth.c-2.us-east-2.aws.neon.build/dbname/auth
 *     → dataApi: https://ep-xxx.apirest.c-2.us-east-2.aws.neon.build/dbname/rest/v1
 */
export const defaultDeriveNeonUrls: DeriveNeonUrls = (baseUrl) => {
	const url = new URL(baseUrl);

	if (url.search !== "" || url.hash !== "") {
		throw new Error(
			`Invalid Neon base URL: must not include a query string or hash fragment (got "${baseUrl}").`,
		);
	}

	if (url.username !== "" || url.password !== "") {
		throw new Error(
			`Invalid Neon base URL: must not include credentials (got "${baseUrl}").`,
		);
	}

	const labels = url.hostname.split(".");
	if (labels.length < 3) {
		throw new Error(
			`Invalid Neon base URL: hostname "${url.hostname}" must have at least 3 dot-separated labels (e.g. ep-xxx.region.tld).`,
		);
	}

	const [first, ...rest] = labels;
	const authHost = [first, "neonauth", ...rest].join(".");
	const dataApiHost = [first, "apirest", ...rest].join(".");

	const basePath = url.pathname.replace(/\/+$/, "");
	const port = url.port ? `:${url.port}` : "";

	return {
		auth: `${url.protocol}//${authHost}${port}${basePath}/auth`,
		dataApi: `${url.protocol}//${dataApiHost}${port}${basePath}/rest/v1`,
	};
};
