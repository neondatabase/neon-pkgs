// Preloaded with `node --import` by the performance budget test. Records every module the
// process loads and which module first imported it, then writes both to the file named by
// NEON_PERF_MODULE_LOG on exit. `module.registerHooks` needs Node >= 22.15.
import { writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

const logPath = process.env.NEON_PERF_MODULE_LOG;
if (!logPath) {
	throw new Error("module-hook.mjs: NEON_PERF_MODULE_LOG is not set");
}

// A Set: Node 22 runs the load hook twice for some CommonJS files.
const loaded = new Set();
const parents = {};

registerHooks({
	resolve(specifier, context, nextResolve) {
		const result = nextResolve(specifier, context);
		if (context.parentURL && !(result.url in parents)) {
			parents[result.url] = context.parentURL;
		}
		return result;
	},
	load(url, context, nextLoad) {
		if (url.startsWith("file:")) {
			loaded.add(url);
		}
		return nextLoad(url, context);
	},
});

process.on("exit", () => {
	writeFileSync(logPath, JSON.stringify({ loaded: [...loaded], parents }));
});
