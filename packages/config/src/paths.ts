/**
 * Public re-export of the config-directory resolution.
 *
 * The implementation lives in `shared/cli-core`, which every CLI in this repo compiles into its
 * own build — see that directory's README. It cannot live here: `neon-init` needs the same
 * resolution and deliberately has no workspace dependencies, so importing `@neon/config` for a
 * file path would pull `@neon/sdk`, `jiti` and `zod` into its install footprint.
 *
 * This subpath stays because it is the published face of that logic. **The re-export is
 * deliberately explicit rather than `export *`**: the shared module also carries credential
 * paths and ownership checks that the CLIs need and consumers should not see, and a star would
 * quietly publish every one of them the next time something was added to it.
 */
export {
	CONFIG_DIR_NAME,
	type ConfigPathOptions,
	configDir,
	LEGACY_CONFIG_DIR_NAME,
	legacyConfigDir,
	type ResolvedConfigFile,
	resolveConfigFile,
} from "./_shared/paths.js";
