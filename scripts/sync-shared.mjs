/**
 * Copy `shared/cli-core/src` into every consumer's `src/_shared`.
 *
 * Runs before each consumer builds and before its tests. See `shared/cli-core/README.md` for why
 * this is a copy rather than a workspace package: every build here emits bare specifiers, so
 * shared code has to be part of the consumer's own source to survive into a published `dist`.
 *
 * Tests are excluded — they run once, from `packages/cli`, rather than in every consumer.
 */
import { cpSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "shared/cli-core/src");

const consumers = [
	"packages/cli",
	"packages/config",
	"packages/env",
	"packages/init",
];

for (const consumer of consumers) {
	const destination = resolve(root, consumer, "src/_shared");
	rmSync(destination, { recursive: true, force: true });
	cpSync(source, destination, {
		recursive: true,
		filter: (path) => !/\.test\.ts$/.test(path),
	});
}
