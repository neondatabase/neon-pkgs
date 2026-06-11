import pkg from "../../package.json" with { type: "json" };

// Package version, used in the User-Agent suffix sent to the gateway. Derived
// from package.json so it stays in sync with the changeset version bump flow.
export const VERSION: string = pkg.version;
