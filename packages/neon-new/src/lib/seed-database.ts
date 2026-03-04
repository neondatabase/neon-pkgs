import { neon } from "@neondatabase/serverless";
import { getSqlCommands } from "./utils/fs.js";

export async function seedDatabase(
	schemaFilePath: string,
	connectionString: string,
) {
	const client = neon(connectionString);
	const commands = getSqlCommands(schemaFilePath);

	for (const command of commands) {
		await client.query(command);
	}
}
