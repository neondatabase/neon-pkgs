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

/**
 * Totals from the rows `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` returns: one
 * row whose `QUERY PLAN` column holds the plan document.
 */
export const extractExecutionMetrics = (rows: unknown): QueryMetrics => {
	const metrics: QueryMetrics = {
		executionTime: 0,
		planningTime: 0,
		totalCost: 0,
		actualRows: 0,
		bufferUsage: {
			shared: { hit: 0, read: 0, written: 0, dirtied: 0 },
			local: { hit: 0, read: 0, written: 0, dirtied: 0 },
		},
	};
	const firstRow = Array.isArray(rows) ? rows[0] : undefined;
	const documents = isRecord(firstRow) ? firstRow["QUERY PLAN"] : undefined;
	const document = Array.isArray(documents) ? documents[0] : undefined;
	if (!isRecord(document)) {
		throw new Error("EXPLAIN returned no JSON plan document");
	}

	metrics.planningTime = numberAt(document, "Planning Time");
	metrics.executionTime = numberAt(document, "Execution Time");

	const visit = (node: unknown) => {
		if (!isRecord(node)) return;
		metrics.totalCost = Math.max(
			metrics.totalCost,
			numberAt(node, "Total Cost"),
		);
		metrics.actualRows += numberAt(node, "Actual Rows");
		for (const kind of ["shared", "local"] as const) {
			const prefix = kind === "shared" ? "Shared" : "Local";
			const buffers = metrics.bufferUsage[kind];
			buffers.hit += numberAt(node, `${prefix} Hit Blocks`);
			buffers.read += numberAt(node, `${prefix} Read Blocks`);
			buffers.written += numberAt(node, `${prefix} Written Blocks`);
			buffers.dirtied += numberAt(node, `${prefix} Dirtied Blocks`);
		}
		const children = node.Plans;
		if (Array.isArray(children)) {
			for (const child of children) visit(child);
		}
	};
	visit(document.Plan);
	return metrics;
};
