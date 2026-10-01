import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { writer } from "./writer.js";

const getMockWritable = () => {
	const chunks: string[] = [];
	const stream = new PassThrough();
	stream.on("data", (chunk) => {
		chunks.push(chunk.toString());
	});

	return {
		stream,
		getData: () => {
			return chunks.join("");
		},
	};
};

describe("writer", () => {
	describe("humanTitle", () => {
		it("titles the table section without changing the JSON key", () => {
			const table = getMockWritable();
			writer({ output: "table", out: table.stream })
				.write({ foo: "bar" }, { fields: ["foo"], title: "T1" })
				.write(
					{ baz: "xyz" },
					{
						fields: ["baz"],
						title: "machine_key",
						humanTitle: "For people",
					},
				)
				.end();
			expect(stripAnsi(table.getData())).toContain("\nFor people\n");
			expect(stripAnsi(table.getData())).not.toContain("machine_key");

			const json = getMockWritable();
			writer({ output: "json", out: json.stream })
				.write({ foo: "bar" }, { fields: ["foo"], title: "T1" })
				.write(
					{ baz: "xyz" },
					{
						fields: ["baz"],
						title: "machine_key",
						humanTitle: "For people",
					},
				)
				.end();
			expect(JSON.parse(json.getData())).toEqual({
				t1: { foo: "bar" },
				machine_key: { baz: "xyz" },
			});
		});
	});

	describe("NO_COLOR", () => {
		it("writes table output without ANSI escapes", () => {
			const previous = process.env.NO_COLOR;
			process.env.NO_COLOR = "1";
			try {
				const { stream, getData } = getMockWritable();
				writer({ output: "table", out: stream }).end(
					[{ foo: "\u001b[32mbar\u001b[39m" }],
					{ fields: ["foo"], title: "T" },
				);
				expect(getData()).not.toMatch(/\u001b\[/);
				expect(getData()).toContain("bar");
			} finally {
				if (previous === undefined) {
					delete process.env.NO_COLOR;
				} else {
					process.env.NO_COLOR = previous;
				}
			}
		});
	});

	describe("outputs yaml", () => {
		it("outputs single data", () => {
			const { stream, getData } = getMockWritable();
			const out = writer({ output: "yaml", out: stream });
			out.end({ foo: "bar" }, { fields: ["foo"] });
			expect(getData()).toMatchSnapshot();
		});

		it("outputs single data with title", () => {
			const { stream, getData } = getMockWritable();
			const out = writer({ output: "yaml", out: stream });
			out.end({ foo: "bar" }, { fields: ["foo"], title: "baz" });
			expect(getData()).toMatchSnapshot();
		});

		it("outputs multiple data", () => {
			const { stream, getData } = getMockWritable();
			const out = writer({ output: "yaml", out: stream });
			out.write({ foo: "bar" }, { fields: ["foo"], title: "T1" })
				.write({ baz: "xyz" }, { fields: ["baz"], title: "T2" })
				.end();
			expect(getData()).toMatchSnapshot();
		});
	});

	describe("outputs json", () => {
		it("ends the document with a newline", () => {
			const objectOut = getMockWritable();
			writer({ output: "json", out: objectOut.stream }).end(
				{ foo: "bar" },
				{ fields: ["foo"] },
			);
			const objectJson = objectOut.getData();
			expect(objectJson.endsWith("}\n")).toBe(true);
			expect(JSON.parse(objectJson)).toEqual({ foo: "bar" });

			const arrayOut = getMockWritable();
			writer({ output: "json", out: arrayOut.stream }).end(
				[{ foo: "bar" }],
				{
					fields: ["foo"],
				},
			);
			const arrayJson = arrayOut.getData();
			expect(arrayJson.endsWith("]\n")).toBe(true);
			expect(JSON.parse(arrayJson)).toEqual([{ foo: "bar" }]);
		});

		it("outputs single data", () => {
			const { stream, getData } = getMockWritable();
			const out = writer({ output: "json", out: stream });
			out.end({ foo: "bar" }, { fields: ["foo"] });
			expect(getData()).toMatchSnapshot();
		});

		it("outputs single data with title", () => {
			const { stream, getData } = getMockWritable();
			const out = writer({ output: "json", out: stream });
			out.end({ foo: "bar" }, { fields: ["foo"], title: "baz" });
			expect(getData()).toMatchSnapshot();
		});

		it("outputs multiple data", () => {
			const { stream, getData } = getMockWritable();
			const out = writer({ output: "json", out: stream });
			out.write({ foo: "bar" }, { fields: ["foo"], title: "T1" })
				.write({ baz: "xyz" }, { fields: ["baz"], title: "T2" })
				.end();
			expect(getData()).toMatchSnapshot();
		});
	});

	describe("outputs table", () => {
		it("outputs single data", () => {
			const { stream, getData } = getMockWritable();
			const out = writer({ output: "table", out: stream });
			out.end({ foo: "bar", extra: "extra" }, { fields: ["foo"] });
			expect(stripAnsi(getData())).toBe("Foo  bar\n");
		});

		it("outputs single data with title", () => {
			const { stream, getData } = getMockWritable();
			const out = writer({ output: "table", out: stream });
			out.end(
				{ foo: "bar", extra: "extra" },
				{ fields: ["foo"], title: "baz" },
			);
			expect(stripAnsi(getData())).toBe("baz\nFoo  bar\n");
		});

		it("outputs multiple data", () => {
			const { stream, getData } = getMockWritable();
			const out = writer({ output: "table", out: stream });
			out.write(
				{ foo: "bar", extra: "extra" },
				{ fields: ["foo"], title: "T1" },
			)
				.write(
					{ baz: "xyz", extra: "extra" },
					{ fields: ["baz"], title: "T2" },
				)
				.end();
			expect(stripAnsi(getData())).toBe("T1\nFoo  bar\n\nT2\nBaz  xyz\n");
		});

		it("prints every list column when the stream is narrower than the row", () => {
			const { stream, getData } = getMockWritable();
			Object.assign(stream, { columns: 40 });
			const out = writer({ output: "table", out: stream });
			out.end(
				[
					{
						id: "wandering-haze-25754674",
						name: "claimable-neon-local-state",
						region: "aws-us-east-2",
					},
				],
				{ fields: ["id", "name", "region"] },
			);
			const text = stripAnsi(getData());
			expect(text).toContain("wandering-haze-25754674");
			expect(text).toContain("claimable-neon-local-state");
			expect(text).toContain("aws-us-east-2");
			expect(text).not.toContain("...");
			expect(text.trimEnd().split("\n")).toHaveLength(2);
		});

		it("outputs table with custom renderer", () => {
			const { stream, getData } = getMockWritable();
			const out = writer({
				output: "table",
				out: stream,
			});
			out.write(
				{ foo: "bar" },
				{
					fields: ["foo"],
					title: "T1",
					renderColumns: {
						foo: ({ foo }) => `Here is: ${foo}`,
					},
				},
			).end();
			expect(stripAnsi(getData())).toBe("T1\nFoo  Here is: bar\n");
		});
	});
});
