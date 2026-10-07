import type { RealtimeClient } from "@neon/realtime/client";
import {
	createContext,
	createElement,
	type ReactElement,
	useContext,
} from "react";
import type { RealtimeProviderProps } from "./types.js";

export const RealtimeContext = createContext<RealtimeClient | null>(null);

/**
 * Provide one shared Realtime client to descendant {@link useLiveQuery} and
 * {@link useRealtimeClient} hooks.
 *
 * Create the client once for the browser application. The provider does not
 * fetch sealed queries or close the client when it unmounts.
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

/**
 * Read the shared Realtime client from the nearest {@link RealtimeProvider}.
 *
 * Use it alongside {@link useLiveQuery} when a component needs the client
 * itself: to pass it to `realtimeCollectionOptions()` from
 * `@neon/realtime-tanstack`, or to call `subscribe()` with a sealed query
 * directly. Subscriptions opened through `subscribe()` are not owned by React,
 * so call `unsubscribe()` when they are no longer needed.
 *
 * @returns The client passed to the nearest provider.
 * @throws If used outside a {@link RealtimeProvider}.
 *
 * @example
 * ```tsx
 * import type { SealedLiveQuery } from "@neon/realtime/client";
 * import { useRealtimeClient } from "@neon/realtime-react";
 * import { realtimeCollectionOptions } from "@neon/realtime-tanstack";
 * import { createCollection } from "@tanstack/db";
 * import { useMemo } from "react";
 *
 * interface Todo {
 *   id: string;
 *   title: string;
 * }
 *
 * function useTodos(query: SealedLiveQuery<Todo>) {
 *   const client = useRealtimeClient();
 *   return useMemo(
 *     () =>
 *       createCollection(realtimeCollectionOptions({
 *         client,
 *         query,
 *         getKey: (todo) => todo.id,
 *       })),
 *     [client, query],
 *   );
 * }
 * ```
 */
export function useRealtimeClient(): RealtimeClient {
	const client = useContext(RealtimeContext);
	if (!client)
		throw new Error("useRealtimeClient requires a RealtimeProvider");
	return client;
}
