import YAML from "yaml";
import { isCi } from "./env.js";
import { formatHumanChunk, resolveOutputWidth } from "./human_table.js";
import type { CommonProps } from "./types.js";
import { toSnakeCase } from "./utils/string.js";

type ExtractFromArray<T> = T extends (infer R)[] ? R : T;
type OnlyStrings<T> = T extends string ? T : never;
type FullExtract<T> = OnlyStrings<keyof ExtractFromArray<T>>;

type WriteOutConfig<T> = {
	// Fields to output in human-readable format
	fields: readonly FullExtract<T>[];
	// Title of the output
	title?: string;
	// Display message if data is empty
	// does not apply to json and yaml output
	emptyMessage?: string;
	// Custom render functions for specific columns
	renderColumns?: Partial<
		Record<FullExtract<T>, (value: ExtractFromArray<T>) => string>
	>;
};

type Chunk = { data: any; config: WriteOutConfig<any> };

const writeYaml = (chunks: Chunk[]) => {
	return YAML.stringify(
		chunks.length === 1
			? chunks[0].data
			: Object.fromEntries(
					chunks.map(({ config, data }, idx) => [
						config.title ? toSnakeCase(config.title) : idx,
						data,
					]),
				),
		null,
		2,
	);
};

const writeJson = (chunks: Chunk[]) => {
	const json = JSON.stringify(
		chunks.length === 1
			? chunks[0].data
			: Object.fromEntries(
					chunks.map(({ config, data }, idx) => [
						config.title ? toSnakeCase(config.title) : idx,
						data,
					]),
				),
		null,
		2,
	);
	return json === undefined ? json : `${json}\n`;
};

const writeTable = (
	chunks: { data: any; config: WriteOutConfig<any> }[],
	out: NodeJS.WritableStream,
	width: number | undefined,
) => {
	chunks.forEach(({ data, config }, i) => {
		out.write(
			formatHumanChunk({
				data,
				fields: config.fields,
				title: config.title,
				emptyMessage: config.emptyMessage,
				renderColumns: config.renderColumns,
				width,
				colorTitle: !isCi(),
				leadingBlank: i > 0 && Boolean(config.title),
			}),
		);
	});
};

/**
 *
 * Parses the output format, takes data and writes the output to stdout.
 *
 * @example
 * const { data } = await props.apiClient.listProjectBranches(props.project.id);
 * // to output single data
 * writer(props).end(data, { fields: ['id', 'name', 'created_at'] })
 * // to output multiple data
 * writer(props)
 *   .write(data, { fields: ['id', 'name', 'created_at'], title: 'branches' })
 *   .write(data, { fields: ['id', 'created_at'], title: 'endpoints' })
 *   .end()
 */
export const writer = (
	props: Pick<CommonProps, "output"> & {
		out?: NodeJS.WritableStream;
		columns?: number | null;
	},
) => {
	const out = props.out ?? process.stdout;
	const width = resolveOutputWidth(out, props.columns, {
		stdout: process.stdout,
		envColumns: process.env.COLUMNS,
	});
	const chunks: { data: any; config: WriteOutConfig<any> }[] = [];

	return {
		write<T>(data: T, config: WriteOutConfig<T>) {
			chunks.push({ data, config });
			return this;
		},
		text(data: string) {
			return out.write(data);
		},
		end: <T>(...args: [T, WriteOutConfig<T>] | []) => {
			if (args.length === 2) {
				chunks.push({ data: args[0], config: args[1] });
			}

			if (props.output == "yaml") {
				return out.write(writeYaml(chunks));
			}

			if (props.output == "json") {
				return out.write(writeJson(chunks));
			}

			writeTable(chunks, out, width);
		},
	};
};
