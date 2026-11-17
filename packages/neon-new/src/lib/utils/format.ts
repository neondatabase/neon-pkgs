function getPoolerString(connString: string) {
	const isPooler = connString.includes("pooler");
	if (isPooler) {
		return connString;
	}

	const [start, ...end] = connString.split(".");
	return `${start}-pooler.${end.join(".")}`;
}

function getDirectString(connString: string) {
	const isDirect = !connString.includes("pooler");
	if (isDirect) {
		return connString;
	}
	const [first, ...rest] = connString.split(".");
	const directFirst = first.replace("-pooler", "");

	return [directFirst, ...rest].join(".");
}

export function getConnectionStrings(connString: string) {
	return {
		pooler: getPoolerString(connString),
		direct: getDirectString(connString),
	};
}

const MASK = "****";

// Everything between `scheme://user:` and the last `@`, as written. Greedy so
// that a raw `@` in the password is covered, the way URL parsing splits it.
const RAW_PASSWORD = /^[^:/]+:\/\/[^:/@]*:(.*)@/;

function safeDecode(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function getPasswords(connString: string) {
	const candidates = [RAW_PASSWORD.exec(connString)?.[1] ?? ""];
	try {
		candidates.push(new URL(connString).password);
	} catch {}
	return [...new Set(candidates.flatMap((p) => [p, safeDecode(p)]))]
		.filter(Boolean)
		.sort((a, b) => b.length - a.length);
}

/**
 * Returns the connection string with its password replaced, for printing to a
 * terminal. A string whose password URL parsing cannot find is never echoed
 * back, since the password could be anywhere in it.
 */
export function redactConnectionString(connString: string) {
	try {
		const url = new URL(connString);
		if (url.host && (url.password || !RAW_PASSWORD.test(connString))) {
			if (url.password) {
				url.password = MASK;
			}
			return url.href;
		}
	} catch {}
	return "<connection string hidden>";
}

/**
 * Replaces every occurrence of the connection string's password in `text`:
 * as written, as URL parsing encodes it, and percent-decoded.
 */
export function maskPassword(text: string, connString: string) {
	let masked = text;
	for (const password of getPasswords(connString)) {
		masked = masked.replaceAll(password, MASK);
	}
	return masked;
}
