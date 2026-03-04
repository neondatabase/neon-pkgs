/**
 * Validates the path to the .env file - it can be dotfile or not.
 * @param value - The path to the .env file
 * @returns An error if the path is invalid, otherwise undefined
 */
function validateEnvPath(value: string) {
	if (!value) return undefined;

	if (!/^\.?[\w-]+(?:\.[\w-]+)*$/.test(value)) {
		return new Error(
			"Please enter a valid file name (e.g.: .env or .env.local)",
		);
	}

	return undefined;
}

/**
 * Validates the key for the .env file - it can only be uppercase letters or digits and underscores (SCREAMING_SNAKE_CASE).
 * @param value - The key for the .env file
 * @returns An error if the key is invalid, otherwise undefined
 */
function validateEnvKey(value: string) {
	if (!value) return undefined;

	if (!/^[A-Z][A-Z0-9_]*$/.test(value)) {
		return new Error(
			"Please enter a valid environment variable key (e.g.: DATABASE_URL)",
		);
	}
	return undefined;
}

export { validateEnvPath, validateEnvKey };
