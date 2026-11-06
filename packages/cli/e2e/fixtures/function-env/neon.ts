import { defineConfig } from "@neon/config/v1";

// Two Functions that each import this file for parseEnv, so each runtime evaluates the
// other Function's declarations without holding its secret. function-env.e2e.test.ts.
export default defineConfig({
	functions: {
		alpha: {
			name: "function env alpha",
			source: "./alpha.ts",
			env: {
				SECRET_A: { required: true },
				OPTIONAL_A: { required: false },
				KEPT_A: { required: false, ifUnset: "keep" },
				RATE_A: { default: "1" },
			},
		},
		beta: {
			name: "function env beta",
			source: "./beta.ts",
			env: { SECRET_B: { required: true } },
		},
	},
});
