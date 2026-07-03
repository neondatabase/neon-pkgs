// Loader for upstream PostgreSQL regression SQL + expected outputs, used
// as ground truth by `regress.spec.ts`. The files are VENDORED under
// `tests/psql-conformance/fixtures/upstream/<PG_TAG>/` (see that dir's
// README.md) and the pinned tag lives in `tests/psql-conformance/POSTGRES_REF`.
//
// Why vendored rather than fetched: the harness previously downloaded these
// from raw.githubusercontent.com at bootstrap, which needs public egress at
// test time. The Databricks protected CI runner group has no such egress
// (JFrog mirror only), so conformance could not run there. Vendoring the six
// files removes the network dependency; bumping the pin is a documented
// re-fetch step (fixtures/upstream/README.md).
//
// Files read (relative to fixtures/upstream/<tag>/):
//
//   sql/psql.sql
//   sql/psql_crosstab.sql
//   sql/psql_pipeline.sql
//   expected/psql.out
//   expected/psql_crosstab.out
//   expected/psql_pipeline.out
//
// Returns a map keyed by the SHORT NAME used by `regress.spec.ts`
// (`'psql' | 'psql_crosstab' | 'psql_pipeline'`) with both `.sql` and
// `.expected` strings.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const POSTGRES_REF_PATH = resolve(HERE, "..", "POSTGRES_REF");
const FIXTURES_ROOT = resolve(HERE, "..", "fixtures", "upstream");

export type RegressCaseName = "psql" | "psql_crosstab" | "psql_pipeline";

export type UpstreamRegressFixture = {
	readonly sql: string;
	readonly expected: string;
};

const REGRESS_CASES: readonly RegressCaseName[] = [
	"psql",
	"psql_crosstab",
	"psql_pipeline",
];

/**
 * Parse `POSTGRES_REF` for the pinned tag. Throws if missing — the
 * loader cannot pick a fixture directory without a pin.
 */
const readPgTag = (): string => {
	const raw = readFileSync(POSTGRES_REF_PATH, "utf8");
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		const key = trimmed.slice(0, eq).trim();
		if (key === "PG_TAG") return trimmed.slice(eq + 1).trim();
	}
	throw new Error(`PG_TAG missing from ${POSTGRES_REF_PATH}`);
};

const readFixture = (
	tag: string,
	kind: "sql" | "expected",
	name: string,
): string => {
	const ext = kind === "sql" ? "sql" : "out";
	const path = join(FIXTURES_ROOT, tag, kind, `${name}.${ext}`);
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(
			`vendored regress fixture missing: ${path} — re-fetch for PG_TAG=${tag} ` +
				`(see tests/psql-conformance/fixtures/upstream/README.md). Cause: ${String(err)}`,
		);
	}
};

/**
 * Load SQL + expected for every regress case from the vendored fixtures for
 * the pinned tag. Returns a map keyed by short name. Throws if any file is
 * missing (no partial success — a half-loaded fixture set would silently
 * break tests). Async signature is retained so callers' `await` is unchanged.
 */
export const fetchRegressFixtures = async (): Promise<
	Map<RegressCaseName, UpstreamRegressFixture>
> => {
	const tag = readPgTag();
	const map = new Map<RegressCaseName, UpstreamRegressFixture>();
	for (const name of REGRESS_CASES) {
		map.set(name, {
			sql: readFixture(tag, "sql", name),
			expected: readFixture(tag, "expected", name),
		});
	}
	return map;
};

/**
 * Path to our OWN seed script (`test_setup_minimal.sql`). Not from
 * upstream — we maintain it. Lives under `tests/psql-conformance/seed/`.
 */
export const SEED_SCRIPT_HOST_PATH = join(
	HERE,
	"..",
	"seed",
	"test_setup_minimal.sql",
);
