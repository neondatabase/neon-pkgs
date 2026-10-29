import pkg from "../../package.json" with { type: "json" };

// The Neon Auth server reads this value with /^(\d+)\.(\d+)/ to pick the
// protocol generation; a range string such as "~1.7.12" fails that match and
// the client is treated as legacy. It therefore reports the floor of the
// dependency specifier, which must share major.minor with every version the
// specifier admits. Only an exact version, "=x.y.z" and "~x.y.z" qualify:
// "^x.y.z" admits later minors, and compound, wildcard and prerelease forms
// have no single floor. The resolved version cannot be read at runtime because
// better-auth does not export its package.json.
export const SUPPORTED_SPECIFIER = /^[~=]?(\d+\.\d+\.\d+)$/;

export function floorOfRange(range: string): string {
	const match =
		typeof range === "string" ? SUPPORTED_SPECIFIER.exec(range) : null;
	if (!match) {
		throw new Error(
			`Cannot derive a bare x.y.z better-auth version from ${JSON.stringify(range)}; use an exact version or a ~x.y.z range`,
		);
	}
	return match[1] as string;
}

export const BETTER_AUTH_VERSION: string = floorOfRange(
	pkg.dependencies["better-auth"],
);
