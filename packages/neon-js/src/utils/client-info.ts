import { BETTER_AUTH_VERSION, type getAdapterName } from "@neon/auth";
import { getClientInfo as getInternalClientInfo } from "@neon-internals/internal";
import pkg from "../../package.json" with { type: "json" };

export function buildNeonJsClientInfo(
	adapter?: ReturnType<typeof getAdapterName>,
): string {
	const info = getInternalClientInfo(pkg.name, pkg.version, {
		betterAuthVersion: BETTER_AUTH_VERSION,
		adapter,
	});
	return JSON.stringify(info);
}

export {
	type ClientInfo,
	getClientInfo,
	injectClientInfo,
	X_NEON_CLIENT_INFO_HEADER,
} from "@neon/postgrest-js";
