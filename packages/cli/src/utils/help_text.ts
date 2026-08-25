export const HELP_WRAP = 78;

export const helpCsv = (
	label: string,
	items: readonly string[],
	width = HELP_WRAP,
): string => {
	if (items.length === 0) {
		throw new Error(`${label} needs at least one value.`);
	}
	const prefix = `${label}:`;
	const lines: string[] = [];
	let line = prefix;
	for (const item of items) {
		const addition = line === prefix ? ` ${item}` : `, ${item}`;
		if (line.length + addition.length > width && line !== prefix) {
			lines.push(line);
			line = `  ${item}`;
		} else {
			line += addition;
		}
	}
	lines.push(line);
	return lines.join("\n");
};
