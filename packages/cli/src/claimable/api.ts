const REQUEST_TIMEOUT_MS = 60_000;
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

export const DEFAULT_CLAIMABLE_ORIGIN = "https://claimable.neon.tech";

export type ClaimableCapability =
	| "postgres"
	| "data_api"
	| "auth"
	| "storage"
	| "functions"
	| "ai_gateway";

export type CapabilityDecision =
	| { capability: string; granted: true }
	| {
			capability: string;
			granted: false;
			reason: string;
			message: string;
	  };

export type Registration = {
	registrationId: string;
	identityAssertion: string;
	assertionExpires: number;
	scopes: string[];
	project: {
		id: string;
		branchId: string;
		expiresAt: string;
	};
	capabilities: CapabilityDecision[];
};

export type ClaimableAccessToken = {
	accessToken: string;
	expiresIn: number;
	scope: string;
};

export type ClaimableCredentials = {
	projectId: string;
	branchId: string;
	databaseUrl: string;
	expiresAt: string;
	services: {
		auth?: {
			baseUrl: string;
			jwksUrl: string;
		};
		dataApi?: { url: string };
	};
};

export type ClaimCode = {
	userCode: string;
	verificationUri: string;
	verificationUriComplete: string;
	expiresIn: number;
	interval: number;
};

export type ClaimStatus = {
	state: string;
	expiresAt: string;
	reconciled: boolean;
};

type ClaimableErrorMetadata = {
	code: string;
	message: string;
	retryable: boolean;
	requestId?: string;
};

export class ClaimableServiceError extends Error {
	readonly status: number;
	readonly code: string;
	readonly retryable: boolean;
	readonly requestId?: string;
	readonly details: unknown;

	constructor(
		status: number,
		metadata: ClaimableErrorMetadata,
		details?: unknown,
	) {
		super(metadata.message);
		this.name = "ClaimableServiceError";
		this.status = status;
		this.code = metadata.code;
		this.retryable = metadata.retryable;
		this.requestId = metadata.requestId;
		this.details = details;
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown, action: string): Record<string, unknown> => {
	if (!isRecord(value)) {
		throw invalidResponse(action);
	}
	return value;
};

const stringField = (
	value: Record<string, unknown>,
	key: string,
	action: string,
): string => {
	const field = value[key];
	if (typeof field !== "string" || field.length === 0) {
		throw invalidResponse(action);
	}
	return field;
};

const stringFieldAllowEmpty = (
	value: Record<string, unknown>,
	key: string,
	action: string,
): string => {
	const field = value[key];
	if (typeof field !== "string") {
		throw invalidResponse(action);
	}
	return field;
};

const numberField = (
	value: Record<string, unknown>,
	key: string,
	action: string,
): number => {
	const field = value[key];
	if (typeof field !== "number" || !Number.isFinite(field) || field <= 0) {
		throw invalidResponse(action);
	}
	return field;
};

const booleanField = (
	value: Record<string, unknown>,
	key: string,
	action: string,
): boolean => {
	const field = value[key];
	if (typeof field !== "boolean") {
		throw invalidResponse(action);
	}
	return field;
};

const stringArrayField = (
	value: Record<string, unknown>,
	key: string,
	action: string,
): string[] => {
	const field = value[key];
	if (
		!Array.isArray(field) ||
		!field.every((item) => typeof item === "string" && item.length > 0)
	) {
		throw invalidResponse(action);
	}
	return field;
};

const invalidResponse = (action: string): Error =>
	new Error(
		`Claimable Neon returned an invalid response while ${action}. The response was not used.`,
	);

const parseCapabilityDecision = (
	value: unknown,
	action: string,
): CapabilityDecision => {
	const decision = record(value, action);
	const capability = stringField(decision, "capability", action);
	const granted = booleanField(decision, "granted", action);
	if (granted) return { capability, granted: true };
	return {
		capability,
		granted: false,
		reason: stringField(decision, "reason", action),
		message: stringField(decision, "message", action),
	};
};

export const parseRegistrationResponse = (value: unknown): Registration => {
	const action = "registering an anonymous identity";
	const response = record(value, action);
	const project = record(response.project, action);
	const capabilities = response.capabilities;
	if (!Array.isArray(capabilities)) throw invalidResponse(action);
	return {
		registrationId: stringField(response, "registration_id", action),
		identityAssertion: stringField(response, "identity_assertion", action),
		assertionExpires: numberField(response, "assertion_expires", action),
		scopes: stringArrayField(response, "scopes", action),
		project: {
			id: stringField(project, "id", action),
			branchId: stringField(project, "branch_id", action),
			expiresAt: stringField(project, "expires_at", action),
		},
		capabilities: capabilities.map((item) =>
			parseCapabilityDecision(item, action),
		),
	};
};

export const parseTokenResponse = (value: unknown): ClaimableAccessToken => {
	const action = "exchanging the identity assertion";
	const response = record(value, action);
	if (response.token_type !== "Bearer") throw invalidResponse(action);
	return {
		accessToken: stringField(response, "access_token", action),
		expiresIn: numberField(response, "expires_in", action),
		scope: stringFieldAllowEmpty(response, "scope", action),
	};
};

export const parseCredentialsResponse = (
	value: unknown,
): ClaimableCredentials => {
	const action = "fetching project credentials";
	const response = record(value, action);
	const services = record(response.services, action);
	const authValue = services.auth;
	const dataApiValue = services.data_api;
	const auth =
		authValue === undefined
			? undefined
			: (() => {
					const parsed = record(authValue, action);
					return {
						baseUrl: stringField(parsed, "base_url", action),
						jwksUrl: stringField(parsed, "jwks_url", action),
					};
				})();
	const dataApi =
		dataApiValue === undefined
			? undefined
			: (() => {
					const parsed = record(dataApiValue, action);
					return { url: stringField(parsed, "url", action) };
				})();
	return {
		projectId: stringField(response, "project_id", action),
		branchId: stringField(response, "branch_id", action),
		databaseUrl: stringField(response, "database_url", action),
		expiresAt: stringField(response, "expires_at", action),
		services: {
			...(auth === undefined ? {} : { auth }),
			...(dataApi === undefined ? {} : { dataApi }),
		},
	};
};

export const parseClaimCodeResponse = (value: unknown): ClaimCode => {
	const action = "starting the claim ceremony";
	const response = record(value, action);
	return {
		userCode: stringField(response, "user_code", action),
		verificationUri: stringField(response, "verification_uri", action),
		verificationUriComplete: stringField(
			response,
			"verification_uri_complete",
			action,
		),
		expiresIn: numberField(response, "expires_in", action),
		interval: numberField(response, "interval", action),
	};
};

export const parseClaimStatusResponse = (value: unknown): ClaimStatus => {
	const action = "fetching claim status";
	const response = record(value, action);
	return {
		state: stringField(response, "state", action),
		expiresAt: stringField(response, "expires_at", action),
		reconciled: booleanField(response, "reconciled", action),
	};
};

const normalizeOrigin = (origin: string): string => {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error(`Invalid Claimable Neon origin "${origin}".`);
	}
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	) {
		throw new Error(
			`Claimable Neon origin must contain only a scheme and host, got "${origin}".`,
		);
	}
	if (url.protocol !== "https:" && url.hostname !== "localhost") {
		throw new Error(
			"Claimable Neon requires HTTPS except when testing against localhost.",
		);
	}
	return url.origin;
};

const parseErrorMetadata = (
	status: number,
	statusText: string,
	payload: unknown,
): ClaimableErrorMetadata => {
	if (!isRecord(payload) || !isRecord(payload.error)) {
		return {
			code: "unknown_error",
			message: `Claimable Neon returned HTTP ${status} ${statusText}.`,
			retryable: status === 429 || status >= 500,
		};
	}
	const error = payload.error;
	return {
		code:
			typeof error.code === "string" && error.code.length > 0
				? error.code
				: "unknown_error",
		message:
			typeof error.message === "string" && error.message.length > 0
				? error.message
				: `Claimable Neon returned HTTP ${status} ${statusText}.`,
		retryable:
			typeof error.retryable === "boolean"
				? error.retryable
				: status === 429 || status >= 500,
		requestId:
			typeof error.request_id === "string" ? error.request_id : undefined,
	};
};

const readJson = async (response: Response): Promise<unknown> => {
	const text = await response.text();
	if (text.trim() === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(
			`Claimable Neon returned non-JSON content with HTTP ${response.status}.`,
		);
	}
};

export class ClaimableClient {
	readonly origin: string;

	constructor(origin = DEFAULT_CLAIMABLE_ORIGIN) {
		this.origin = normalizeOrigin(origin);
	}

	async register(input: {
		capabilities: readonly ClaimableCapability[];
		source: string;
	}): Promise<Registration> {
		return parseRegistrationResponse(
			await this.request("/v1/agent/identity", {
				method: "POST",
				json: {
					type: "anonymous",
					capabilities: input.capabilities,
					source: input.source,
				},
			}),
		);
	}

	async exchange(identityAssertion: string): Promise<ClaimableAccessToken> {
		return parseTokenResponse(
			await this.request("/v1/oauth2/token", {
				method: "POST",
				form: new URLSearchParams({
					grant_type: JWT_BEARER_GRANT,
					assertion: identityAssertion,
					resource: `${this.origin}/`,
				}),
			}),
		);
	}

	async credentials(
		projectId: string,
		accessToken: string,
	): Promise<ClaimableCredentials> {
		return parseCredentialsResponse(
			await this.request(
				`/v1/projects/${encodeURIComponent(projectId)}/credentials`,
				{ accessToken },
			),
		);
	}

	async createClaim(
		projectId: string,
		accessToken: string,
	): Promise<ClaimCode> {
		return parseClaimCodeResponse(
			await this.request(
				`/v1/projects/${encodeURIComponent(projectId)}/claim`,
				{ method: "POST", accessToken },
			),
		);
	}

	async claimStatus(
		projectId: string,
		accessToken: string,
	): Promise<ClaimStatus> {
		return parseClaimStatusResponse(
			await this.request(
				`/v1/projects/${encodeURIComponent(projectId)}/claim`,
				{ accessToken },
			),
		);
	}

	async deleteProject(projectId: string, accessToken: string): Promise<void> {
		await this.request(`/v1/projects/${encodeURIComponent(projectId)}`, {
			method: "DELETE",
			accessToken,
		});
	}

	private async request(
		path: string,
		options: {
			method?: "GET" | "POST" | "DELETE";
			accessToken?: string;
			json?: unknown;
			form?: URLSearchParams;
		} = {},
	): Promise<unknown> {
		const headers = new Headers({ accept: "application/json" });
		if (options.accessToken) {
			headers.set("authorization", `Bearer ${options.accessToken}`);
		}
		let body: string | undefined;
		if (options.json !== undefined) {
			headers.set("content-type", "application/json");
			body = JSON.stringify(options.json);
		} else if (options.form !== undefined) {
			headers.set("content-type", "application/x-www-form-urlencoded");
			body = options.form.toString();
		}

		let response: Response;
		try {
			response = await fetch(new URL(path, `${this.origin}/`), {
				method: options.method ?? "GET",
				headers,
				body,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new Error(
				`Could not reach Claimable Neon at ${this.origin}. Check the connection and retry.`,
			);
		}
		const payload = await readJson(response);
		if (!response.ok) {
			throw new ClaimableServiceError(
				response.status,
				parseErrorMetadata(
					response.status,
					response.statusText,
					payload,
				),
				payload,
			);
		}
		return payload;
	}
}
