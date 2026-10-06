interface PostgreSqlType {
	readonly oid: number;
	readonly arrayOid: number;
	readonly arrayDelimiter?: string;
}

/** Return a stable built-in PostgreSQL type OID, or `0` for inference. */
export function postgresTypeOid(sqlType: string): number {
	const { baseType, isArray } = splitArrayType(sqlType);
	const type = postgresType(baseType);
	return type === undefined ? 0 : isArray ? type.arrayOid : type.oid;
}

/** Return a stable built-in PostgreSQL array OID, or `0` for inference. */
export function postgresArrayTypeOid(elementType: string): number {
	return postgresType(splitArrayType(elementType).baseType)?.arrayOid ?? 0;
}

/** Return the delimiter used by a built-in PostgreSQL array element type. */
export function postgresArrayDelimiter(elementType: string): string {
	const type = postgresType(splitArrayType(elementType).baseType);
	return type?.arrayDelimiter ?? ",";
}

export function normalizePostgresType(sqlType: string): string {
	return splitArrayType(sqlType).baseType;
}

function splitArrayType(sqlType: string): {
	readonly baseType: string;
	readonly isArray: boolean;
} {
	const normalized = sqlType.trim().toLowerCase().replace(/\s+/g, " ");
	const baseType = normalized.replace(/(?:\[\d*\])+$/, "").trim();
	return { baseType, isArray: baseType !== normalized };
}

function postgresType(type: string): PostgreSqlType | undefined {
	// Built-in type OIDs are stable across PostgreSQL databases. Database-local
	// enums, domains, extensions, and custom types deliberately fall back to 0.
	if (/^(?:bool|boolean)$/.test(type)) return pgType(16, 1000);
	if (type === "bytea") return pgType(17, 1001);
	if (type === "name") return pgType(19, 1003);
	if (/^(?:smallint|int2|smallserial)$/.test(type)) return pgType(21, 1005);
	if (type === "int2vector") return pgType(22, 1006);
	if (/^(?:integer|int|int4|serial)$/.test(type)) return pgType(23, 1007);
	if (type === "regproc") return pgType(24, 1008);
	if (/^(?:bigint|int8|bigserial)$/.test(type)) return pgType(20, 1016);
	if (/^(?:real|float4)$/.test(type)) return pgType(700, 1021);
	if (/^(?:double precision|float8)$/.test(type)) return pgType(701, 1022);
	if (/^(?:numeric|decimal)(?:\s*\([^)]*\))?$/.test(type)) {
		return pgType(1700, 1231);
	}
	if (type === "text") return pgType(25, 1009);
	if (type === "tid") return pgType(27, 1010);
	if (type === "xid") return pgType(28, 1011);
	if (type === "cid") return pgType(29, 1012);
	if (type === "oidvector") return pgType(30, 1013);
	if (/^(?:varchar|character varying)(?:\s*\(\d+\))?$/.test(type)) {
		return pgType(1043, 1015);
	}
	if (/^(?:char|character)(?:\s*\(\d+\))?$/.test(type)) {
		return pgType(1042, 1014);
	}
	if (type === "uuid") return pgType(2950, 2951);
	if (type === "json") return pgType(114, 199);
	if (type === "jsonb") return pgType(3802, 3807);
	if (type === "date") return pgType(1082, 1182);
	if (
		/^timestamp(?:\s*\(\d+\))? with time zone$/.test(type) ||
		type === "timestamptz"
	) {
		return pgType(1184, 1185);
	}
	if (/^timestamp(?:\s*\(\d+\))?(?: without time zone)?$/.test(type)) {
		return pgType(1114, 1115);
	}
	if (
		/^time(?:\s*\(\d+\))? with time zone$/.test(type) ||
		type === "timetz"
	) {
		return pgType(1266, 1270);
	}
	if (/^time(?:\s*\(\d+\))?(?: without time zone)?$/.test(type)) {
		return pgType(1083, 1183);
	}
	if (type.startsWith("interval")) return pgType(1186, 1187);
	if (type === "inet") return pgType(869, 1041);
	if (type === "cidr") return pgType(650, 651);
	if (type === "macaddr") return pgType(829, 1040);
	if (type === "macaddr8") return pgType(774, 775);
	if (type === "point") return pgType(600, 1017);
	if (type === "line") return pgType(628, 629);
	if (type === "lseg") return pgType(601, 1018);
	if (type === "path") return pgType(602, 1019);
	if (type === "box") return pgType(603, 1020, ";");
	if (type === "polygon") return pgType(604, 1027);
	if (type === "circle") return pgType(718, 719);
	if (type === "money") return pgType(790, 791);
	if (type === "oid") return pgType(26, 1028);
	if (type === "aclitem") return pgType(1033, 1034);
	if (type === "xml") return pgType(142, 143);
	if (/^bit(?:\s*\(\d+\))?$/.test(type)) return pgType(1560, 1561);
	if (/^(?:varbit|bit varying)(?:\s*\(\d+\))?$/.test(type)) {
		return pgType(1562, 1563);
	}
	if (type === "refcursor") return pgType(1790, 2201);
	if (type === "regprocedure") return pgType(2202, 2207);
	if (type === "regoper") return pgType(2203, 2208);
	if (type === "regoperator") return pgType(2204, 2209);
	if (type === "regclass") return pgType(2205, 2210);
	if (type === "regtype") return pgType(2206, 2211);
	if (type === "txid_snapshot") return pgType(2970, 2949);
	if (type === "pg_lsn") return pgType(3220, 3221);
	if (type === "tsvector") return pgType(3614, 3643);
	if (type === "tsquery") return pgType(3615, 3645);
	if (type === "regconfig") return pgType(3734, 3735);
	if (type === "regdictionary") return pgType(3769, 3770);
	if (type === "int4range") return pgType(3904, 3905);
	if (type === "numrange") return pgType(3906, 3907);
	if (type === "tsrange") return pgType(3908, 3909);
	if (type === "tstzrange") return pgType(3910, 3911);
	if (type === "daterange") return pgType(3912, 3913);
	if (type === "int8range") return pgType(3926, 3927);
	if (type === "jsonpath") return pgType(4072, 4073);
	if (type === "regnamespace") return pgType(4089, 4090);
	if (type === "regrole") return pgType(4096, 4097);
	if (type === "regcollation") return pgType(4191, 4192);
	if (type === "int4multirange") return pgType(4451, 6150);
	if (type === "nummultirange") return pgType(4532, 6151);
	if (type === "tsmultirange") return pgType(4533, 6152);
	if (type === "tstzmultirange") return pgType(4534, 6153);
	if (type === "datemultirange") return pgType(4535, 6155);
	if (type === "int8multirange") return pgType(4536, 6157);
	if (type === "pg_snapshot") return pgType(5038, 5039);
	if (type === "xid8") return pgType(5069, 271);
	return undefined;
}

function pgType(
	oid: number,
	arrayOid: number,
	arrayDelimiter?: string,
): PostgreSqlType {
	return Object.freeze({ oid, arrayOid, arrayDelimiter });
}
