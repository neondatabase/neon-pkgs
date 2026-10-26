import { createServer } from "node:http";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins/admin";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";
import { NEON_AUTH_JWKS_PATH } from "../server/endpoints";

export interface ReceivedRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	body: unknown;
	status: number;
}

export interface LocalBetterAuth {
	/** Base URL to hand to `createAuthClient` or `createAuthServer`. */
	authUrl: string;
	origin: string;
	received: ReceivedRequest[];
	last: () => ReceivedRequest;
	close: () => Promise<void>;
}

/**
 * A real Better Auth server with the plugins Neon Auth serves, so tests observe
 * the requests the SDK sends and the routes that accept them.
 */
export async function startLocalBetterAuth(): Promise<LocalBetterAuth> {
	const received: ReceivedRequest[] = [];
	let origin = "";
	let handler: (request: Request) => Promise<Response> = async () =>
		new Response(null, { status: 503 });

	const server = createServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk);
		const raw = Buffer.concat(chunks);
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const headers = new Headers();
		for (const [name, value] of Object.entries(req.headers)) {
			if (typeof value === "string") headers.set(name, value);
		}
		const response = await handler(
			new Request(`${origin}${url.pathname}${url.search}`, {
				method: req.method,
				headers,
				body: raw.length > 0 ? raw : undefined,
			}),
		);
		const text = raw.toString("utf8");
		received.push({
			method: req.method ?? "",
			path: url.pathname,
			query: url.searchParams,
			body:
				text && headers.get("content-type")?.includes("json")
					? JSON.parse(text)
					: undefined,
			status: response.status,
		});
		res.writeHead(response.status, Object.fromEntries(response.headers));
		res.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve),
	);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("the local Better Auth server has no TCP address");
	}
	origin = `http://127.0.0.1:${address.port}`;

	const auth = betterAuth({
		baseURL: origin,
		secret: "test-secret-at-least-32-characters-long!",
		database: memoryAdapter(
			Object.fromEntries(
				[
					"user",
					"session",
					"account",
					"verification",
					"jwks",
					"organization",
					"member",
					"invitation",
					"oauthClient",
					"oauthAccessToken",
					"oauthRefreshToken",
					"oauthConsent",
				].map((model) => [model, []]),
			),
		),
		trustedOrigins: [origin],
		emailAndPassword: { enabled: true },
		plugins: [
			admin(),
			organization(),
			emailOTP({ sendVerificationOTP: async () => {} }),
			jwt({ jwks: { jwksPath: NEON_AUTH_JWKS_PATH } }),
			oauthProvider({ loginPage: "/login", consentPage: "/consent" }),
		],
	});
	handler = auth.handler;

	return {
		authUrl: `${origin}/api/auth`,
		origin,
		received,
		last: () => {
			const request = received.at(-1);
			if (!request)
				throw new Error(
					"the local Better Auth server received no request",
				);
			return request;
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
