import { describe, expect, test } from "vitest";
import { keepPostgresSelected } from "./service_picker.js";

describe("keepPostgresSelected", () => {
	test("re-selects postgres after it is toggled off", () => {
		const prompt = {
			value: [
				{ value: "postgres", selected: false },
				{ value: "auth", selected: true },
			],
		};
		keepPostgresSelected(prompt);
		expect(prompt.value[0]?.selected).toBe(true);
		expect(prompt.value[1]?.selected).toBe(true);
	});
});
