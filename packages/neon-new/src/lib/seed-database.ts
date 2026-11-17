import { neon } from "@neondatabase/serverless";
import { maskPassword } from "./utils/format.js";
import { getSqlCommands } from "./utils/fs.js";

export async function seedDatabase(
	schemaFilePath: string,
	connectionString: string,
) {
	try {
		const client = neon(connectionString);
		const commands = getSqlCommands(schemaFilePath);

		for (const command of commands) {
			await client.query(command);
		}
	} catch (error) {
		// The driver's errors can quote the connection string. Rethrow without
		// `cause`, since Node prints the cause of an uncaught error too.
		if (error instanceof Error) {
			const message = maskPassword(error.message, connectionString);
			if (message !== error.message) {
				throw new Error(message);
			}
		}
		throw error;
	}
}
