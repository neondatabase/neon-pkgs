import { toByteArray } from "base64-js";

export function decodeBase64(value: string): Uint8Array {
	return toByteArray(value);
}
