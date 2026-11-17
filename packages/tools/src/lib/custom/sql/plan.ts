interface BufferMetrics {
	hit: number;
	read: number;
	written: number;
	dirtied: number;
}

export interface QueryMetrics {
	executionTime: number;
	planningTime: number;
	totalCost: number;
	actualRows: number;
	bufferUsage: {
		shared: BufferMetrics;
		local: BufferMetrics;
	};
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const numberAt = (node: Record<string, unknown>, key: string): number => {
	const value = node[key];
	return typeof value === "number" ? value : 0;
};

export interface PlanTable {
	/** `schema.relation`, as the plan spells it. */
	name: string;
	/** The quoted SQL name, which resolves to exactly this relation. */
	quotedName: string;
}

const quoteIdentifier = (identifier: string) =>
	`"${identifier.replaceAll('"', '""')}"`;

/** Every relation an `EXPLAIN (FORMAT JSON)` result scans. */
export const extractTablesFromPlan = (plan: unknown): PlanTable[] => {
	const tables = new Map<string, PlanTable>();
	const visit = (node: unknown) => {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (!isRecord(node)) return;
		const relation = node["Relation Name"];
		const schema = node.Schema;
		if (typeof relation === "string" && typeof schema === "string") {
			const quotedName = `${quoteIdentifier(schema)}.${quoteIdentifier(relation)}`;
			tables.set(quotedName, {
				name: `${schema}.${relation}`,
				quotedName,
			});
		}
		for (const value of Object.values(node)) visit(value);
	};
	visit(plan);
	return [...tables.values()];
};

const buffers = (
	node: Record<string, unknown>,
	prefix: "Shared" | "Local",
) => ({
	hit: numberAt(node, `${prefix} Hit Blocks`),
	read: numberAt(node, `${prefix} Read Blocks`),
	written: numberAt(node, `${prefix} Written Blocks`),
	dirtied: numberAt(node, `${prefix} Dirtied Blocks`),
});

/**
 * Query-level totals from the rows `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`
 * returns: one row whose `QUERY PLAN` column holds the plan document. They come
 * from the root plan node, because a parent node's cost, rows, and buffer
 * counters already include its children.
 */
const planDocument = (rows: unknown) => {
	const firstRow = Array.isArray(rows) ? rows[0] : undefined;
	const documents = isRecord(firstRow) ? firstRow["QUERY PLAN"] : undefined;
	const document = Array.isArray(documents) ? documents[0] : undefined;
	const root = isRecord(document) ? document.Plan : undefined;
	return isRecord(document) && isRecord(root)
		? { document, root }
		: undefined;
};

/** Whether `rows` hold the JSON plan document `EXPLAIN (FORMAT JSON)` returns. */
export const hasPlanDocument = (rows: unknown): boolean => {
	const nodeType = planDocument(rows)?.root["Node Type"];
	return typeof nodeType === "string" && nodeType !== "";
};

export const extractExecutionMetrics = (rows: unknown): QueryMetrics => {
	const plan = planDocument(rows);
	if (plan === undefined) {
		throw new Error("EXPLAIN returned no JSON plan document");
	}
	const { document, root } = plan;
	return {
		executionTime: numberAt(document, "Execution Time"),
		planningTime: numberAt(document, "Planning Time"),
		totalCost: numberAt(root, "Total Cost"),
		actualRows: numberAt(root, "Actual Rows"),
		bufferUsage: {
			shared: buffers(root, "Shared"),
			local: buffers(root, "Local"),
		},
	};
};
