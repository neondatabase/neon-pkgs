import { parseEnv } from "@neon/env";
import config from "./neon.js";

export default {
	fetch: () => Response.json(parseEnv(config, "beta").function),
};
