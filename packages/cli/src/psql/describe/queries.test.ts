import { describe, expect, it } from "vitest";

import * as q from "./queries.js";
import { PG_12, PG_17, PG_18, PG_19 } from "./versionGate.js";

describe("describe/queries — pg17 snapshots", () => {
	/* ----- Representative subset: both verbose=false and verbose=true ----- */

	describe("describeAggregates", () => {
		it("pg17 / verbose=false", () => {
			expect(
				q.describeAggregates({ serverVersion: PG_17 }),
			).toMatchSnapshot();
		});
		it("pg17 / verbose=true", () => {
			expect(
				q.describeAggregates({ serverVersion: PG_17, verbose: true }),
			).toMatchSnapshot();
		});
	});

	describe("describeFunctions", () => {
		it("pg17 / verbose=false", () => {
			expect(
				q.describeFunctions({ serverVersion: PG_17 }),
			).toMatchSnapshot();
		});
		it("pg17 / verbose=true", () => {
			expect(
				q.describeFunctions({ serverVersion: PG_17, verbose: true }),
			).toMatchSnapshot();
		});
		it("pg17 / functypes=ap (aggregates+procedures)", () => {
			expect(
				q.describeFunctions({ serverVersion: PG_17, functypes: "ap" }),
			).toMatchSnapshot();
		});
	});

	describe("describeTableDetails", () => {
		it("pg17 / verbose=false", () => {
			expect(
				q.describeTableDetails({ serverVersion: PG_17 }),
			).toMatchSnapshot();
		});
		it("pg17 / verbose=true / showSystem", () => {
			expect(
				q.describeTableDetails({
					serverVersion: PG_17,
					verbose: true,
					showSystem: true,
				}),
			).toMatchSnapshot();
		});
	});

	describe("listTables", () => {
		it("pg17 / verbose=false / default tabtypes", () => {
			expect(q.listTables({ serverVersion: PG_17 })).toMatchSnapshot();
		});
		it("pg17 / verbose=true / tabtypes=ti", () => {
			expect(
				q.listTables({
					serverVersion: PG_17,
					verbose: true,
					tabtypes: "ti",
				}),
			).toMatchSnapshot();
		});
		it("pg12 / verbose=true (no tableam join semantics differ)", () => {
			expect(
				q.listTables({
					serverVersion: PG_12,
					verbose: true,
					tabtypes: "t",
				}),
			).toMatchSnapshot();
		});
	});

	describe("listSchemas", () => {
		it("pg17 / verbose=false", () => {
			expect(q.listSchemas({ serverVersion: PG_17 })).toMatchSnapshot();
		});
		it("pg17 / verbose=true", () => {
			expect(
				q.listSchemas({ serverVersion: PG_17, verbose: true }),
			).toMatchSnapshot();
		});
	});

	describe("listAllDbs", () => {
		it("pg17 / verbose=false", () => {
			expect(q.listAllDbs({ serverVersion: PG_17 })).toMatchSnapshot();
		});
		it("pg17 / verbose=true", () => {
			expect(
				q.listAllDbs({ serverVersion: PG_17, verbose: true }),
			).toMatchSnapshot();
		});
	});

	describe("describeRoles", () => {
		it("pg17 / verbose=false", () => {
			expect(q.describeRoles({ serverVersion: PG_17 })).toMatchSnapshot();
		});
		it("pg17 / verbose=true", () => {
			expect(
				q.describeRoles({ serverVersion: PG_17, verbose: true }),
			).toMatchSnapshot();
		});
	});

	/* ----- Remaining variants: single PG_17 default-opts snapshot each ----- */

	it("describeAccessMethods / pg17", () => {
		expect(
			q.describeAccessMethods({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("describeTablespaces / pg17", () => {
		expect(
			q.describeTablespaces({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("describeTypes / pg17", () => {
		expect(q.describeTypes({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("describeOperators / pg17", () => {
		expect(q.describeOperators({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("permissionsList / pg17", () => {
		expect(q.permissionsList({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listDefaultACLs / pg17", () => {
		expect(q.listDefaultACLs({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("objectDescription / pg17", () => {
		expect(q.objectDescription({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listDbRoleSettings / pg17", () => {
		expect(
			q.listDbRoleSettings({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("describeRoleGrants / pg17", () => {
		expect(
			q.describeRoleGrants({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listPartitionedTables / pg17", () => {
		expect(
			q.listPartitionedTables({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listLanguages / pg17", () => {
		expect(q.listLanguages({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listDomains / pg17", () => {
		expect(q.listDomains({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listConversions / pg17", () => {
		expect(q.listConversions({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("describeConfigurationParameters / pg17", () => {
		expect(
			q.describeConfigurationParameters({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listEventTriggers / pg17", () => {
		expect(q.listEventTriggers({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listExtendedStats / pg17", () => {
		expect(q.listExtendedStats({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listCasts / pg17", () => {
		expect(q.listCasts({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listCollations / pg17", () => {
		expect(q.listCollations({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listTSParsers / pg17 verbose=false", () => {
		expect(q.listTSParsers({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listTSParsers / pg17 verbose=true", () => {
		expect(
			q.listTSParsers({ serverVersion: PG_17, verbose: true }),
		).toMatchSnapshot();
	});

	it("describeOneTSParser / fixed oid", () => {
		expect(q.describeOneTSParser({ oid: "3722" })).toMatchSnapshot();
	});

	it("listTSDictionaries / pg17", () => {
		expect(
			q.listTSDictionaries({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listTSTemplates / pg17", () => {
		expect(q.listTSTemplates({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listTSConfigs / pg17 verbose=false", () => {
		expect(q.listTSConfigs({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listTSConfigs / pg17 verbose=true", () => {
		expect(
			q.listTSConfigs({ serverVersion: PG_17, verbose: true }),
		).toMatchSnapshot();
	});

	it("listForeignDataWrappers / pg17", () => {
		expect(
			q.listForeignDataWrappers({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listForeignServers / pg17", () => {
		expect(
			q.listForeignServers({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listUserMappings / pg17", () => {
		expect(q.listUserMappings({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listForeignTables / pg17", () => {
		expect(q.listForeignTables({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listExtensions / pg17", () => {
		expect(q.listExtensions({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("listExtensionContents / pg17", () => {
		expect(q.listExtensionContents()).toMatchSnapshot();
	});

	it("listOneExtensionContents / fixed oid", () => {
		expect(q.listOneExtensionContents({ oid: "12345" })).toMatchSnapshot();
	});

	it("listPublications / pg17", () => {
		expect(q.listPublications({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("describePublications / pg17", () => {
		expect(
			q.describePublications({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("describeSubscriptions / pg17", () => {
		expect(
			q.describeSubscriptions({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listOperatorClasses / pg17", () => {
		expect(
			q.listOperatorClasses({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listOperatorFamilies / pg17", () => {
		expect(
			q.listOperatorFamilies({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listOpFamilyOperators / pg17", () => {
		expect(
			q.listOpFamilyOperators({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listOpFamilyFunctions / pg17", () => {
		expect(
			q.listOpFamilyFunctions({ serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("listLargeObjects / pg17", () => {
		expect(q.listLargeObjects({ serverVersion: PG_17 })).toMatchSnapshot();
	});

	it("showFunction / fixed name", () => {
		expect(
			q.showFunction({ name: "myschema.fn(int)", serverVersion: PG_17 }),
		).toMatchSnapshot();
	});

	it("showView / fixed name", () => {
		expect(
			q.showView({ name: "public.my_view", serverVersion: PG_17 }),
		).toMatchSnapshot();
	});
});

// PG 18 added new columns / rows / WHERE branches to several catalog
// queries. The pg17 block above already pins the older shape; this
// block pins the PG-18 SQL so future edits cannot silently drop a
// version branch (e.g. removing the `Leakproof?` column from
// `listOpFamilyOperators` would change this snapshot without changing
// the pg17 one).
describe("describe/queries — pg18 snapshots (PG-18-only branches)", () => {
	it("describeFunctions / pg18 / verbose=true (Leakproof?)", () => {
		expect(
			q.describeFunctions({ serverVersion: PG_18, verbose: true }),
		).toMatchSnapshot();
	});

	it("describeOperators / pg18", () => {
		expect(q.describeOperators({ serverVersion: PG_18 })).toMatchSnapshot();
	});

	it("describePublications / pg18 (Generated columns)", () => {
		expect(
			q.describePublications({ serverVersion: PG_18 }),
		).toMatchSnapshot();
	});

	it("listCasts / pg18", () => {
		expect(q.listCasts({ serverVersion: PG_18 })).toMatchSnapshot();
	});

	it("listDefaultACLs / pg18", () => {
		expect(q.listDefaultACLs({ serverVersion: PG_18 })).toMatchSnapshot();
	});

	it("listExtensions / pg18 (Default version)", () => {
		expect(q.listExtensions({ serverVersion: PG_18 })).toMatchSnapshot();
	});

	it("listOpFamilyOperators / pg18 / verbose=true (Leakproof?)", () => {
		expect(
			q.listOpFamilyOperators({ serverVersion: PG_18, verbose: true }),
		).toMatchSnapshot();
	});

	it("listPublications / pg18 (Generated columns)", () => {
		expect(q.listPublications({ serverVersion: PG_18 })).toMatchSnapshot();
	});

	it("fetchNotNullConstraints / pg18 queries contype = n", () => {
		const { sql } = q.fetchNotNullConstraints({
			oid: 42,
			serverVersion: PG_18,
		});
		expect(sql).toContain("co.contype = 'n'");
		expect(sql).toContain("co.conrelid = '42'");
		expect(sql).toContain(
			"co.conname, at.attname, co.connoinherit, co.conislocal",
		);
		expect(sql).toContain("ORDER BY at.attnum");
	});

	it("fetchNotNullConstraints / pre-pg18 returns an empty stub", () => {
		const { sql } = q.fetchNotNullConstraints({
			oid: 42,
			serverVersion: PG_17,
		});
		// Pre-PG-18 servers have no named NOT NULL constraints; the builder
		// emits a zero-row stub rather than querying pg_constraint.
		expect(sql).toContain("WHERE false");
		expect(sql).not.toContain("contype = 'n'");
	});
});

// PG-19-only branches: sequence replication (puballsequences), publication
// EXCEPT lists (prexcept), and the new \dRs+ subscription columns.
describe("describe/queries — pg19 snapshots (PG-19-only branches)", () => {
	it("listPublications / pg19 (All sequences)", () => {
		expect(q.listPublications({ serverVersion: PG_19 })).toMatchSnapshot();
	});

	it("describePublications / pg19 (puballsequences)", () => {
		expect(
			q.describePublications({ serverVersion: PG_19 }),
		).toMatchSnapshot();
	});

	it("describeSubscriptions / pg19 / verbose=true (Server, retention, receiver timeout)", () => {
		expect(
			q.describeSubscriptions({ serverVersion: PG_19, verbose: true }),
		).toMatchSnapshot();
	});

	it("listPublications / pg19 surfaces the All sequences column", () => {
		const { sql } = q.listPublications({ serverVersion: PG_19 });
		expect(sql).toContain('puballsequences AS "All sequences"');
	});

	it("listPublications / pre-pg19 omits the All sequences column", () => {
		const { sql } = q.listPublications({ serverVersion: PG_18 });
		expect(sql).not.toContain("puballsequences");
	});

	it("describeSubscriptions / pg19 adds retention + server + receiver-timeout columns", () => {
		const { sql } = q.describeSubscriptions({
			serverVersion: PG_19,
			verbose: true,
		});
		expect(sql).toContain('subretaindeadtuples AS "Retain dead tuples"');
		expect(sql).toContain('submaxretention AS "Max retention duration"');
		expect(sql).toContain('subretentionactive AS "Retention active"');
		expect(sql).toContain('subwalrcvtimeout AS "Receiver timeout"');
		expect(sql).toContain("oid=subserver");
		// Receiver timeout is emitted after Conninfo, matching describe.c.
		expect(sql.indexOf("Conninfo")).toBeLessThan(
			sql.indexOf("Receiver timeout"),
		);
	});

	it("describeSubscriptions / pre-pg19 omits the new columns", () => {
		const { sql } = q.describeSubscriptions({
			serverVersion: PG_18,
			verbose: true,
		});
		expect(sql).not.toContain("subretaindeadtuples");
		expect(sql).not.toContain("subwalrcvtimeout");
		expect(sql).not.toContain("oid=subserver");
	});

	it("fetchTablePublications / pg19 skips EXCEPT rows", () => {
		const { sql } = q.fetchTablePublications({
			oid: 42,
			serverVersion: PG_19,
		});
		expect(sql).toContain("AND NOT pr.prexcept");
		expect(sql).toContain("pr.prrelid = '42'");
	});

	it("fetchTablePublications / pre-pg19 has no EXCEPT guard", () => {
		const { sql } = q.fetchTablePublications({
			oid: 42,
			serverVersion: PG_18,
		});
		expect(sql).not.toContain("prexcept");
	});

	it("fetchExcludedFromPublications / pg19 queries prexcept + partition root", () => {
		const { sql } = q.fetchExcludedFromPublications({
			oid: 42,
			serverVersion: PG_19,
		});
		expect(sql).toContain("AND pr.prexcept");
		expect(sql).toContain("pr.prrelid = '42'");
		expect(sql).toContain("pg_catalog.pg_partition_root");
		expect(sql).toContain("ORDER BY 1");
	});

	it("fetchExcludedFromPublications / pre-pg19 returns an empty stub", () => {
		const { sql } = q.fetchExcludedFromPublications({
			oid: 42,
			serverVersion: PG_18,
		});
		expect(sql).toContain("WHERE false");
		expect(sql).not.toContain("prexcept");
	});

	it("fetchSequencePublications / pg19 queries puballsequences + publishable", () => {
		const { sql } = q.fetchSequencePublications({
			oid: 42,
			serverVersion: PG_19,
		});
		expect(sql).toContain("p.puballsequences");
		expect(sql).toContain("pg_catalog.pg_relation_is_publishable('42')");
		expect(sql).toContain("ORDER BY 1");
	});

	it("fetchSequencePublications / pre-pg19 returns an empty stub", () => {
		const { sql } = q.fetchSequencePublications({
			oid: 42,
			serverVersion: PG_18,
		});
		expect(sql).toContain("WHERE false");
		expect(sql).not.toContain("puballsequences");
	});
});
