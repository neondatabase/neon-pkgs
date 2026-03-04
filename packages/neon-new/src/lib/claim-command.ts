import { log, outro } from "@clack/prompts";
import open from "open";
import { detectClaimUrl } from "./utils/detect-claim-url.js";
import { getDotEnvContent } from "./utils/fs.js";

async function openClaimUrl(claimUrl: string): Promise<void> {
	try {
		log.success(`URL located. Opening your default browser.`);
		await open(claimUrl);
		outro(`You can also manually open: ${claimUrl}.`);
		process.exit(0);
	} catch (error) {
		log.error(
			error instanceof Error ? error.message : "Failed to open claim URL",
		);
		process.exit(1);
	}
}

export async function claim(
	dotEnvPath: string,
	envPrefix?: string,
): Promise<void> {
	const dotEnvContent = getDotEnvContent(dotEnvPath);
	let claimUrl: string | undefined;

	if (envPrefix) {
		const claimUrlKey = `${envPrefix}POSTGRES_CLAIM_URL`;
		claimUrl = dotEnvContent[claimUrlKey];

		if (!claimUrl) {
			log.error(`${claimUrlKey} not found in ${dotEnvPath}.`);
			outro(
				`Use \`neon-new claim -p <prefix>\` to override URL auto-detection.`,
			);
			process.exit(1);
		} else {
			await openClaimUrl(claimUrl);
			return;
		}
	} else {
		claimUrl = detectClaimUrl(dotEnvContent, dotEnvPath);
		await openClaimUrl(claimUrl);
		return;
	}
}
