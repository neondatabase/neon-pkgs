import type { NeonConfig } from "@neon/sdk";

export type NeonBearerCredential = NeonConfig["apiKey"];

const missingCredentialMessage =
	"A Neon API key or OAuth access token is required";

export const missingBearerCredential = (): never => {
	throw new TypeError(missingCredentialMessage);
};

const requireNonEmptyCredential = (value: unknown): string => {
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(missingCredentialMessage);
	}
	return value;
};

export const requireBearerCredential = (
	value: NeonBearerCredential,
): NeonBearerCredential => {
	if (typeof value === "function") {
		return async () => requireNonEmptyCredential(await value());
	}
	return requireNonEmptyCredential(value);
};
