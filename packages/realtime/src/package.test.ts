import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const packageRoot = dirname(
	fileURLToPath(new URL("../package.json", import.meta.url)),
);
const packageRequire = createRequire(import.meta.url);
const schemas = [
	{
		path: "schema/realtime-protocol.schema.json",
		id: "https://neon.tech/schemas/realtime/realtime-protocol-v3.schema.json",
		exports: [
			"schema/realtime-protocol.schema.json",
			"schema/realtime-protocol-v3.schema.json",
		],
	},
	{
		path: "schema/realtime-query-capability.schema.json",
		id: "https://neon.tech/schemas/realtime/realtime-query-capability-v2.schema.json",
		exports: [
			"schema/realtime-query-capability.schema.json",
			"schema/realtime-query-capability-v2.schema.json",
		],
	},
	{
		path: "schema/legacy/realtime-protocol-v1.schema.json",
		id: "https://neon.tech/schemas/realtime/realtime-protocol-v1.schema.json",
		exports: ["schema/realtime-protocol-v1.schema.json"],
	},
	{
		path: "schema/legacy/realtime-protocol-v2.schema.json",
		id: "https://neon.tech/schemas/realtime/realtime-protocol-v2.schema.json",
		exports: ["schema/realtime-protocol-v2.schema.json"],
	},
	{
		path: "schema/legacy/realtime-query-capability-v1.schema.json",
		id: "https://neon.tech/schemas/realtime/realtime-query-capability-v1.schema.json",
		exports: ["schema/realtime-query-capability-v1.schema.json"],
	},
] as const;

describe("@neon/realtime package", () => {
	it("resolves the package root to the client surface on React Native", () => {
		const manifest = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		) as {
			readonly exports: Readonly<
				Record<
					string,
					{
						readonly "react-native"?: {
							readonly types: string;
							readonly import: string;
							readonly default: string;
						};
					}
				>
			>;
		};

		expect(manifest.exports["."]?.["react-native"]).toEqual({
			types: "./dist/index.react-native.d.ts",
			import: "./dist/index.react-native.js",
			default: "./dist/index.react-native.js",
		});
	});

	it("keeps the direct-subscription WebSocket transport opt-in", () => {
		const manifest = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		) as {
			readonly dependencies?: Readonly<Record<string, string>>;
			readonly devDependencies: Readonly<Record<string, string>>;
			readonly peerDependencies: Readonly<Record<string, string>>;
			readonly peerDependenciesMeta: Readonly<
				Record<string, { readonly optional?: boolean }>
			>;
		};

		expect(manifest.dependencies?.ws).toBeUndefined();
		expect(manifest.peerDependencies.ws).toBe(manifest.devDependencies.ws);
		expect(manifest.peerDependenciesMeta.ws?.optional).toBe(true);
	});

	it("publishes current schemas and resolves versioned exports to their own contracts", () => {
		const manifest = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf8"),
		) as {
			readonly exports: Readonly<Record<string, string>>;
		};

		for (const schema of schemas) {
			for (const subpath of schema.exports) {
				const exportedPath = manifest.exports[`./${subpath}`];
				expect(exportedPath).toBe(`./${schema.path}`);
				const resolved = packageRequire.resolve(
					`@neon/realtime/${subpath}`,
				);
				expect(realpathSync(resolved)).toBe(
					realpathSync(join(packageRoot, schema.path)),
				);
				expect(JSON.parse(readFileSync(resolved, "utf8")).$id).toBe(
					schema.id,
				);
			}
		}

		const packDestination = mkdtempSync(
			join(tmpdir(), "neon-realtime-pack-"),
		);
		try {
			execFileSync(
				"npm",
				[
					"pack",
					"--ignore-scripts",
					"--pack-destination",
					packDestination,
				],
				{ cwd: packageRoot, stdio: "ignore" },
			);
			const tarballs = readdirSync(packDestination).filter((path) =>
				path.endsWith(".tgz"),
			);
			expect(tarballs).toHaveLength(1);

			const files = execFileSync(
				"tar",
				["-tf", join(packDestination, tarballs[0] as string)],
				{ encoding: "utf8" },
			).split(/\r?\n/);
			for (const schema of schemas) {
				expect(files).toContain(`package/${schema.path}`);
			}
		} finally {
			rmSync(packDestination, { recursive: true, force: true });
		}
	}, 30_000);
});
