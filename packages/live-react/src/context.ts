import type { NeonLiveClient } from "@neon/live/client";
import { createContext, createElement, type ReactElement } from "react";
import type { NeonLiveProviderProps } from "./types.js";

export const NeonLiveContext = createContext<NeonLiveClient | null>(null);

/**
 * Provide one shared Neon Live client to descendant {@link useLiveQuery}
 * hooks.
 *
 * Create the client once for the browser application. The provider does not
 * fetch query sealed queries or close the client when it unmounts.
 *
 * @param props - Shared client and descendant React tree.
 * @returns A context provider for Neon Live hooks.
 */
export function NeonLiveProvider({
	client,
	children,
}: NeonLiveProviderProps): ReactElement {
	return createElement(NeonLiveContext.Provider, { value: client }, children);
}
