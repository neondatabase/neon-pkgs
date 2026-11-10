const GITHUB_HOSTS = new Set([
	"api.github.com",
	"codeload.github.com",
	"github.com",
	"raw.githubusercontent.com",
]);

export const githubRequestHeaders = (
	url: string | URL,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
	const token = env.GITHUB_TOKEN || env.GH_TOKEN;
	const { protocol, hostname } = new URL(url);
	return {
		"User-Agent": "neon",
		...(token && protocol === "https:" && GITHUB_HOSTS.has(hostname)
			? { Authorization: `Bearer ${token}` }
			: {}),
	};
};
