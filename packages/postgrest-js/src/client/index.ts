// Re-export client-info utilities for packages that need to build custom client info
export {
	type ClientInfo,
	getClientInfo,
	injectClientInfo,
	X_NEON_CLIENT_INFO_HEADER,
} from "../utils/client-info.js";

export { AuthRequiredError, fetchWithToken } from "./fetch-with-token.js";
export {
	type DefaultSchemaName,
	NeonPostgrestClient,
	type NeonPostgrestClientConstructorOptions,
} from "./postgrest-client.js";
