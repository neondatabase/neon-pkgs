export const DEPLOY_COMMANDS_EPILOGUE = [
	"",
	"Use neon deploy with a neon.ts file for a full deployment (declared services and functions).",
	"Use neon functions deploy to deploy one function manually, including a targeted env update.",
	"neon deploy --env <file> loads that .env file so neon.ts can read Function env from it.",
	"neon functions deploy --env-from-file <file> loads a dotenv file; --env KEY=VALUE is repeatable",
	"and overrides matching values from that file.",
].join("\n");
