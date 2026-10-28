import pkg from "../../package.json" with { type: "json" };

const BARE_VERSION = /^\d+\.\d+\.\d+$/;

// The Neon Auth server reads this value with /^(\d+)\.(\d+)/ to pick the
// protocol generation; a range string such as "~1.7.12" fails that match and
// the client is treated as legacy. It therefore reports the floor of the
// dependency range, which shares major.minor with every version the range
// admits. The resolved version cannot be read at runtime because better-auth
// does not export its package.json.
export function floorOfRange(range: string): string {
	const floor = range.replace(/^[~^=]/, "");
	if (!BARE_VERSION.test(floor)) {
		throw new Error(
			`Cannot derive a bare x.y.z better-auth version from "${range}"`,
		);
	}
	return floor;
}

export const BETTER_AUTH_VERSION: string = floorOfRange(
	pkg.dependencies["better-auth"],
);
