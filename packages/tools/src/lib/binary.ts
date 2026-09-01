const bytesToBase64 = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
};

export const decodeBase64 = (value: string): Blob => {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return new Blob([bytes]);
};

export const encodeBlob = async (
	value: Blob,
): Promise<{ base64: string; contentType: string; size: number }> => ({
	base64: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
	contentType: value.type,
	size: value.size,
});
