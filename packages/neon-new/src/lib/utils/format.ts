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
