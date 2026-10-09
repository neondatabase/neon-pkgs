import pkg from "../../package.json" with { type: "json" };

// better-auth must be pinned exactly (no range prefix) in package.json: the
// Neon Auth server parses this with /^(\d+)\.(\d+)/ and treats anything it
// rejects as a legacy SDK.
export const BETTER_AUTH_VERSION: string = pkg.dependencies["better-auth"];
