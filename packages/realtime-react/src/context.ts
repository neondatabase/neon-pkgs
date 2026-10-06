import type { RealtimeClient } from "@neon/realtime/client";
import { createContext, createElement, type ReactElement } from "react";
import type { RealtimeProviderProps } from "./types.js";

export const RealtimeContext = createContext<RealtimeClient | null>(null);

/**
 * Provide one shared Realtime client to descendant {@link useLiveQuery}
 * hooks.
 *
 * Create the client once for the browser application. The provider does not
 * fetch query sealed queries or close the client when it unmounts.
 *
 * @param props - Shared client and descendant React tree.
 * @returns A context provider for Realtime hooks.
 */
export function RealtimeProvider({
	client,
	children,
}: RealtimeProviderProps): ReactElement {
	return createElement(RealtimeContext.Provider, { value: client }, children);
}
