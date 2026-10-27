import pkg from "../package.json" with { type: "json" };

/** Exact package version used only for server compatibility checks. */
export const REALTIME_CLIENT_VERSION: string = pkg.version;

/** Release cohort emitted by the 0.2 SDK. Keep this catalog bounded. */
export const REALTIME_RELEASE_LINE = "0.2" as const;

/** SDK family emitted by the JavaScript client and server packages. */
export const REALTIME_SDK = "javascript" as const;
