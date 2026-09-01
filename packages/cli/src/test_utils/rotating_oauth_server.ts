import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type RotatingOauthServer = {
	url: string;
	refreshAttempts: () => number;
	rotations: () => number;
	issue: (options?: { expiresIn?: number }) => {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		token_type: "bearer";
	};
	revoke: (refreshToken: string) => void;
	setUnreachable: (unreachable: boolean) => void;
	stop: () => Promise<void>;
};

export const startRotatingOauthServer = async (
	options: { accessTokenLifetimeSeconds?: number } = {},
): Promise<RotatingOauthServer> => {
	const lifetime = options.accessTokenLifetimeSeconds ?? 3600;
	const liveRefreshTokens = new Set<string>();
	let refreshAttempts = 0;
	let rotations = 0;
	let unreachable = false;

	const issue = ({ expiresIn = lifetime }: { expiresIn?: number } = {}) => {
		const refresh = `refresh-${randomUUID()}`;
		liveRefreshTokens.add(refresh);
		return {
			access_token: `access-${randomUUID()}`,
			refresh_token: refresh,
			expires_in: expiresIn,
			token_type: "bearer" as const,
		};
	};

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

		if (url.pathname === "/.well-known/openid-configuration") {
			return json(res, 200, {
				issuer: baseUrl(),
				token_endpoint: `${baseUrl()}/oauth2/token`,
				authorization_endpoint: `${baseUrl()}/oauth2/authorize`,
				revocation_endpoint: `${baseUrl()}/oauth2/revoke`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				token_endpoint_auth_methods_supported: ["none"],
				scopes_supported: ["openid", "offline", "offline_access"],
			});
		}

		if (url.pathname === "/oauth2/token" && req.method === "POST") {
			return readBody(req, (body) => {
				const form = new URLSearchParams(body);
				if (form.get("grant_type") !== "refresh_token") {
					return json(res, 400, {
						error: "unsupported_grant_type",
					});
				}

				refreshAttempts += 1;

				if (unreachable) {
					res.destroy();
					return;
				}

				const presented = form.get("refresh_token") ?? "";
				if (!liveRefreshTokens.delete(presented)) {
					return json(res, 400, {
						error: "invalid_grant",
						error_description:
							"The provided authorization grant or refresh token is invalid, expired, or revoked.",
					});
				}

				rotations += 1;
				return json(res, 200, {
					...issue(),
					scope: "openid offline offline_access",
				});
			});
		}

		return json(res, 404, { error: "not_found" });
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});

	const baseUrl = () =>
		`http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		url: baseUrl(),
		refreshAttempts: () => refreshAttempts,
		rotations: () => rotations,
		issue,
		revoke: (refreshToken: string) => {
			liveRefreshTokens.delete(refreshToken);
		},
		setUnreachable: (value: boolean) => {
			unreachable = value;
		},
		stop: () => closeServer(server),
	};
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json;charset=UTF-8",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
};

const readBody = (req: IncomingMessage, next: (body: string) => void): void => {
	let body = "";
	req.on("data", (chunk: Buffer) => {
		body += chunk.toString();
	});
	req.on("end", () => next(body));
};

const closeServer = (server: Server): Promise<void> =>
	new Promise((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
