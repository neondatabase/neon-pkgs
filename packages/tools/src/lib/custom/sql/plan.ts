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

/** Every `schema.relation` an `EXPLAIN (FORMAT JSON)` result scans. */
export const extractTableNamesFromPlan = (plan: unknown): string[] => {
	const tableNames = new Set<string>();
	const visit = (node: unknown) => {
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (!isRecord(node)) return;
		const relation = node["Relation Name"];
		const schema = node.Schema;
		if (typeof relation === "string" && typeof schema === "string") {
			tableNames.add(`${schema}.${relation}`);
		}
		for (const value of Object.values(node)) visit(value);
	};
	visit(plan);
	return [...tableNames];
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
export const extractExecutionMetrics = (rows: unknown): QueryMetrics => {
	const firstRow = Array.isArray(rows) ? rows[0] : undefined;
	const documents = isRecord(firstRow) ? firstRow["QUERY PLAN"] : undefined;
	const document = Array.isArray(documents) ? documents[0] : undefined;
	const root = isRecord(document) ? document.Plan : undefined;
	if (!isRecord(document) || !isRecord(root)) {
		throw new Error("EXPLAIN returned no JSON plan document");
	}
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
