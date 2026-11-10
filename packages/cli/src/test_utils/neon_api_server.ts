import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type NeonApiServer = {
	url: string;
	reject: (accessToken: string) => void;
	rejectAll: (value: boolean) => void;
	failUserLookup: (value: boolean) => void;
	seenTokens: () => string[];
	/** API keys minted through `POST /api_keys`, in order. */
	mintedKeys: () => { id: number; key: string; name: string }[];
	/** Ids revoked through `DELETE /api_keys/:id`. */
	revokedKeyIds: () => number[];
	stop: () => Promise<void>;
};

export const startNeonApiServer = async (
	user: { id: string; email: string } = {
		id: "user-1",
		email: "user@example.com",
	},
): Promise<NeonApiServer> => {
	const rejected = new Set<string>();
	const seen: string[] = [];
	let rejectAll = false;
	let failUserLookup = false;
	const minted: { id: number; key: string; name: string }[] = [];
	const revoked: number[] = [];

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const token = (req.headers.authorization ?? "").replace(
			/^Bearer\s+/i,
			"",
		);

		const keyPath = /^\/api_keys(?:\/(\d+))?$/.exec(url.pathname);
		if (url.pathname !== "/users/me" && keyPath === null) {
			return json(res, 404, { message: "Not Found" });
		}

		seen.push(token);

		if (rejectAll || token === "" || rejected.has(token)) {
			return json(res, 401, { message: "Unauthorized" });
		}

		if (keyPath !== null) {
			if (req.method === "POST" && keyPath[1] === undefined) {
				let body = "";
				req.on("data", (chunk: Buffer) => {
					body += chunk.toString();
				});
				req.on("end", () => {
					const { key_name: name } = JSON.parse(body);
					const created = {
						id: 300 + minted.length,
						key: `napi_minted_${minted.length}`,
						name,
					};
					minted.push(created);
					json(res, 200, {
						...created,
						created_at: "2026-03-01T00:00:00Z",
						created_by: user.id,
					});
				});
				return;
			}
			if (req.method === "DELETE" && keyPath[1] !== undefined) {
				const id = Number(keyPath[1]);
				revoked.push(id);
				return json(res, 200, { id, name: "revoked", revoked: true });
			}
			return json(res, 405, { message: "Method Not Allowed" });
		}

		if (failUserLookup) {
			return json(res, 500, { message: "Internal Server Error" });
		}

		return json(res, 200, {
			id: user.id,
			email: user.email,
			login: "tester",
			name: "Tester",
			projects_limit: 10,
			branches_limit: 10,
			max_autoscaling_limit: 1,
			plan: "free",
			auth_accounts: [],
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});

	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		reject: (accessToken: string) => {
			rejected.add(accessToken);
		},
		rejectAll: (value: boolean) => {
			rejectAll = value;
		},
		failUserLookup: (value: boolean) => {
			failUserLookup = value;
		},
		seenTokens: () => [...seen],
		mintedKeys: () => [...minted],
		revokedKeyIds: () => [...revoked],
		stop: () => closeServer(server),
	};
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
};

const closeServer = (server: Server): Promise<void> =>
	new Promise((resolve, reject) => {
		server.close((err) => (err ? reject(err) : resolve()));
	});
