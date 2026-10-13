import { envReport } from "./report.js";

export default {
	fetch: () => Response.json(envReport()),
};
