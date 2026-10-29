/** Release cohort emitted by the 0.2 SDK. Keep this catalog bounded. */
export const REALTIME_RELEASE_LINE = "0.2" as const;

/** SDK family emitted by the JavaScript client and server packages. */
export const REALTIME_SDK = "javascript" as const;

/** Opaque wire payload so connection metadata can grow without protocol changes. */
export const REALTIME_CLIENT_METADATA = JSON.stringify({
	sdk: REALTIME_SDK,
	release_line: REALTIME_RELEASE_LINE,
});
