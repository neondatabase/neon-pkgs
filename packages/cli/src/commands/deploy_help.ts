export const DEPLOY_COMMANDS_EPILOGUE = [
	"",
	"Use neon deploy with a neon.ts file for a full deployment (declared services and functions).",
	"Use neon functions deploy to deploy one function manually, including a targeted env update.",
	"neon deploy --env <file> loads that .env file so neon.ts can read Function env from it.",
	"neon functions deploy --env is KEY=VALUE (repeatable), not a file path.",
].join("\n");
