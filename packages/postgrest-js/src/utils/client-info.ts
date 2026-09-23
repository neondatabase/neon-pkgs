import { createClientInfoInjector } from "@neon-internals/internal";
import pkg from "../../package.json" with { type: "json" };

export type { ClientInfo } from "@neon-internals/internal";
export {
	getClientInfo,
	X_NEON_CLIENT_INFO_HEADER,
} from "@neon-internals/internal";

export const injectClientInfo = createClientInfoInjector(pkg.name, pkg.version);
