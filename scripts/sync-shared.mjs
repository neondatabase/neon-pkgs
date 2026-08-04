/**
 * Copy `shared/cli-core/src` into one consumer's `src/_shared`.
 *
 * Runs before that consumer compiles anything. See `shared/cli-core/README.md` for why this is a
 * copy rather than a workspace package: every build here emits bare specifiers, so shared code
 * has to be part of the consumer's own source to survive into a published `dist`.
 *
 * **One consumer per invocation, named by the caller.** An earlier version rewrote every tree
 * on every call, so a recursive `pnpm build` — which runs packages concurrently — could delete
 * `_shared` in one package while another was mid-copy or mid-compile.
 *
 * The copy goes to a temporary directory and is renamed into place, so a reader either sees the
 * previous tree or the new one, never a half-written mix.
 *
 * Consumers are `packages/{cli,env,init}`. Tests are excluded: they run once, from
 * `packages/cli`, rather than in every consumer.
 */
import { cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "shared/cli-core/src");

const consumer = process.argv[2];
if (!consumer) {
	console.error(
		"sync-shared: needs the consumer package directory, e.g. `node ../../scripts/sync-shared.mjs .`",
	);
	process.exit(1);
}

const destination = resolve(process.cwd(), consumer, "src/_shared");
const staging = mkdtempSync(join(tmpdir(), "neon-cli-core-"));
try {
	const staged = join(staging, "_shared");
	cpSync(source, staged, {
		recursive: true,
		filter: (path) => !/\.test\.ts$/.test(path),
	});
	rmSync(destination, { recursive: true, force: true });
	renameSync(staged, destination);
} finally {
	rmSync(staging, { recursive: true, force: true });
}
