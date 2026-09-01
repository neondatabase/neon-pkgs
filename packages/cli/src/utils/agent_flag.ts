export const coerceAgentFlag = (value: unknown): string[] => {
	if (value === undefined) return [];
	const list = Array.isArray(value) ? value : [value];
	if (list.length === 0) {
		throw new Error(
			"--agent needs a value. Pass one, or omit the flag entirely.",
		);
	}
	return list.map((item) => {
		if (typeof item !== "string" || item.trim() === "") {
			throw new Error(
				"--agent needs a value. Pass one, or omit the flag entirely.",
			);
		}
		return item;
	});
};

export const agentArgv = (agents: readonly string[]): string[] =>
	agents.flatMap((id) => ["--agent", id]);
