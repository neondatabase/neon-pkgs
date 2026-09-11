import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCredentialInputs } from "@neon-internals/cli-core/auth_selection";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getApiClient } from "../api.js";
import { clearAuthContext } from "../auth_context.js";
import {
	type RotatingOauthServer,
	startRotatingOauthServer,
} from "../test_utils/rotating_oauth_server.js";
import { runAuthenticatedLink } from "./link.js";

type LinkApiServer = {
	url: string;
	reject: (token: string) => void;
	rejectAll: (value: boolean) => void;
	seenTokens: () => string[];
	stop: () => Promise<void>;
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
};

const startLinkApiServer = async (): Promise<LinkApiServer> => {
	const rejected = new Set<string>();
	const seen: string[] = [];
	let rejectAll = false;
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const token = (req.headers.authorization ?? "").replace(
			/^Bearer\s+/i,
			"",
		);
		seen.push(token);
		if (rejectAll || rejected.has(token)) {
			json(res, 401, { message: "Unauthorized" });
			return;
		}
		if (req.method === "GET" && url.pathname === "/projects") {
			json(res, 200, { projects: [], pagination: {} });
			return;
		}
		if (req.method === "POST" && url.pathname === "/projects") {
			json(res, 201, {
				project: {
					id: "project-1",
					name: "init-link-test",
					region_id: "aws-us-east-2",
				},
				branch: { id: "branch-1", name: "main" },
			});
			return;
		}
		json(res, 404, { message: "Not Found" });
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	return {
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		reject: (token) => rejected.add(token),
		rejectAll: (value) => {
			rejectAll = value;
		},
		seenTokens: () => [...seen],
		stop: () =>
			new Promise((resolve, reject) => {
				server.close((error) =>
					error === undefined ? resolve() : reject(error),
				);
			}),
	};
};

let api: LinkApiServer;
let oauth: RotatingOauthServer;
let root = "";

beforeEach(async () => {
	api = await startLinkApiServer();
	oauth = await startRotatingOauthServer();
	root = mkdtempSync(join(tmpdir(), "neon-init-link-"));
	recordCredentialInputs({
		apiKeyFlag: "",
		apiKeyEnv: "",
		profileEnv: "",
		profileFlag: "",
		configDir: root,
	});
});

afterEach(async () => {
	clearAuthContext();
	recordCredentialInputs({
		apiKeyFlag: "",
		apiKeyEnv: "",
		profileEnv: "",
		profileFlag: "",
		configDir: "",
	});
	rmSync(root, { recursive: true, force: true });
	await Promise.all([api.stop(), oauth.stop()]);
});

const seedCredentials = (): string => {
	const issued = oauth.issue();
	writeFileSync(
		join(root, "credentials.json"),
		JSON.stringify({
			...issued,
			type: "oauth",
			expires_at: Date.now() + issued.expires_in * 1000,
			user_id: "user-1",
		}),
		{ mode: 0o600 },
	);
	return issued.access_token;
};

const props = () => ({
	apiClient: getApiClient({
		apiKey: "unused-before-auth",
		apiHost: api.url,
	}),
	apiKey: "",
	apiHost: api.url,
	output: "table" as const,
	contextFile: join(root, ".neon"),
	yes: true,
	clear: false,
	checks: true,
	envPull: false,
	config: false,
	cwd: root,
	configDir: root,
	oauthHost: oauth.url,
	clientId: "test-client",
	orgId: "org-1",
	projectName: "init-link-test",
	regionId: "aws-us-east-2",
});

describe("runAuthenticatedLink", () => {
	test("refreshes the stored session and retries the real link operation", async () => {
		const rejected = seedCredentials();
		api.reject(rejected);

		await runAuthenticatedLink(props());

		expect(oauth.rotations()).toBe(1);
		expect(api.seenTokens()).toHaveLength(3);
		expect(api.seenTokens()[0]).toBe(rejected);
		expect(api.seenTokens()[1]).not.toBe(rejected);
		expect(api.seenTokens()[2]).toBe(api.seenTokens()[1]);
		expect(JSON.parse(readFileSync(join(root, ".neon"), "utf8"))).toEqual({
			orgId: "org-1",
			projectId: "project-1",
			branch: "main",
		});
	});

	test("stops after the refreshed session receives a second 401", async () => {
		seedCredentials();
		api.rejectAll(true);

		await expect(runAuthenticatedLink(props())).rejects.toThrow(
			"Authentication failed.",
		);
		expect(oauth.rotations()).toBe(1);
		expect(api.seenTokens()).toHaveLength(2);
	});
});
