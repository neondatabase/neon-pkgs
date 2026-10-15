import { defineConfig } from "@neon/config/v1";

// Every production service `parseEnv` validates, so a variable one runtime provides and
// another lacks shows up in env-contract.e2e.test.ts. Realtime is not covered yet.
export default defineConfig({
	auth: true,
	dataApi: true,
	aiGateway: true,
	buckets: { probe: {} },
	functions: {
		probe: {
			name: "env contract probe",
			source: "./probe.ts",
			env: { PROBE_SETTING: "probe-value" },
		},
	},
});
