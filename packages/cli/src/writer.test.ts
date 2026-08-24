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
