export const HELP_WRAP = 78;
const WRAP_INDENT = "    ";

export const helpWidth = (): number => {
	const columns = process.stderr.columns ?? process.stdout.columns;
	if (
		typeof columns !== "number" ||
		!Number.isFinite(columns) ||
		columns < 1
	) {
		return HELP_WRAP;
	}
	return Math.max(24, columns - 1);
};

export const helpCsv = (
	label: string,
	items: readonly string[],
	width = helpWidth(),
): string => {
	if (items.length === 0) {
		return "";
	}
	const prefix = `${label}:`;
	const lines: string[] = [];
	let line = prefix;
	for (const item of items) {
		const addition = line === prefix ? ` ${item}` : `, ${item}`;
		if (line.length + addition.length <= width) {
			line += addition;
			continue;
		}
		if (line === prefix) {
			lines.push(prefix);
		} else {
			lines.push(`${line},`);
		}
		line = `${WRAP_INDENT}${item}`;
	}
	lines.push(line);
	return lines.join("\n");
};

export const helpEpilogue = (...blocks: string[]): string =>
	["", ...blocks.filter((block) => block !== "")].join("\n");

export const globalOptionsTrailer = (usage: string): string => {
	const cli = usage.trim().split(/\s+/)[0];
	return `Global options: see ${cli === "" ? "neon" : cli} --help`;
};
