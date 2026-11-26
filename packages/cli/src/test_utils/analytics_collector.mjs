// Preloaded with `--import` into a forked CLI: sends what Segment posts to track.neon.tech
// to the local collector in NEON_TEST_ANALYTICS_COLLECTOR instead.
const TRACK_HOST = "https://track.neon.tech";
const collector = process.env.NEON_TEST_ANALYTICS_COLLECTOR;
if (!collector) {
	throw new Error("NEON_TEST_ANALYTICS_COLLECTOR is not set");
}

const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = String(input);
	return url.startsWith(TRACK_HOST)
		? realFetch(collector + url.slice(TRACK_HOST.length), init)
		: realFetch(input, init);
};
