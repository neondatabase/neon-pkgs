import { CLAIMABLE_POSTGRES_URLS } from "./urls.js";

interface CreateClaimableDBParams {
	dbId: string;
	referrer: string;
	settings?: {
		logicalReplication?: boolean;
	};
}

export async function createClaimableDatabase({
	dbId,
	referrer,
	settings = {},
}: CreateClaimableDBParams) {
	const { logicalReplication = false } = settings;

	const dbCreation = await fetch(
		CLAIMABLE_POSTGRES_URLS.CREATE_DATABASE_POST(dbId, referrer),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				enable_logical_replication: logicalReplication || false,
			}),
		},
	);

	if (!dbCreation.ok) {
		throw new Error("Failed to create database");
	}

	const dbInfo: { connection_string: string } = await fetch(
		CLAIMABLE_POSTGRES_URLS.GET_DATABASE_DATA(dbId),
		{
			method: "GET",
			headers: {
				"Content-Type": "application/json",
			},
		},
	).then((res) => res.json());

	return dbInfo.connection_string;
}
