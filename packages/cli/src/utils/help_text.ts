import { parseColumns } from "../human_table.js";

export const HELP_WRAP = 78;
const WRAP_INDENT = "    ";

export const helpWidth = (): number => {
	const fromStdout = process.stdout.columns;
	if (
		typeof fromStdout === "number" &&
		Number.isFinite(fromStdout) &&
		fromStdout >= 1
	) {
		return Math.max(24, fromStdout - 1);
	}
	const fromEnv = parseColumns(process.env.COLUMNS);
	if (fromEnv !== undefined) {
		return Math.max(24, fromEnv - 1);
	}
	return HELP_WRAP;
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

export const wrapHelpText = (text: string, width: number): string => {
	if (width < 1) {
		return text;
	}
	const words = text
		.trim()
		.split(/\s+/)
		.filter((word) => word !== "");
	if (words.length === 0) {
		return text;
	}
	const lines: string[] = [];
	let line = "";
	for (const word of words) {
		if (line === "") {
			line = word;
			continue;
		}
		if (line.length + 1 + word.length <= width) {
			line = `${line} ${word}`;
			continue;
		}
		lines.push(line);
		line = word;
	}
	if (line !== "") {
		lines.push(line);
	}
	return lines.join("\n");
};

export const helpEpilogue = (...blocks: string[]): string =>
	["", ...blocks.filter((block) => block !== "")].join("\n");
