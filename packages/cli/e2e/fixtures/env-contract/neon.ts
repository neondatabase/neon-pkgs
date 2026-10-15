import { defineConfig } from "@neon/config/v1";

// Every production service `parseEnv` validates, so a variable one runtime provides and
// another lacks shows up in env-contract.e2e.test.ts. Realtime is not covered yet.
// PROBE_SETTING comes from the .env.local the test writes, as in the bot templates.
export default defineConfig({
	auth: true,
	dataApi: true,
	aiGateway: true,
	buckets: { probe: {} },
	functions: {
		probe: {
			name: "env contract probe",
			source: "./probe.ts",
			env: { PROBE_SETTING: process.env.PROBE_SETTING! },
		},
	},
});
