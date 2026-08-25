export const HELP_WRAP = 78;
const WRAP_INDENT = "    ";

export const helpCsv = (
	label: string,
	items: readonly string[],
	width = HELP_WRAP,
): string => {
	if (items.length === 0) {
		return "";
	}
	const prefix = `${label}:`;
	const lines: string[] = [];
	let line = prefix;
	for (const item of items) {
		const addition = line === prefix ? ` ${item}` : `, ${item}`;
		if (line.length + addition.length > width && line !== prefix) {
			lines.push(`${line},`);
			line = `${WRAP_INDENT}${item}`;
		} else {
			line += addition;
		}
	}
	lines.push(line);
	return lines.join("\n");
};
