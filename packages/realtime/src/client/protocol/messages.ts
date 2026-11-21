import type { Column, ServerMessage } from "./wire-types.gen.js";

/** Protocol v3: v2 plus holes, segment rounds and segment tags. */
export const REALTIME_SUBPROTOCOL_V3 = "neon.realtime.v3";
/** Protocol v2, which proxies that predate v3 select. */
export const REALTIME_SUBPROTOCOL_V2 = "neon.realtime.v2";
/** The subprotocols this SDK offers, highest first. The server selects one. */
export const REALTIME_SUBPROTOCOLS = [
	REALTIME_SUBPROTOCOL_V3,
	REALTIME_SUBPROTOCOL_V2,
] as const;
export type RealtimeSubprotocol = (typeof REALTIME_SUBPROTOCOLS)[number];

type ServerVariant<Type extends ServerMessage["type"]> = Extract<
	ServerMessage,
	{ type: Type }
>;

export type ColumnCodec = Column["codec"];
export type SubscribeRejectionCode =
	ServerVariant<"subscribe_rejected">["code"];
export type SubscriptionErrorCode = ServerVariant<"subscription_error">["code"];
export type ConnectionErrorCode = ServerVariant<"connection_error">["code"];

export type {
	Cell as WireCell,
	Change as WireChange,
	ChangeTarget,
	ClientMessage,
	Column as WireColumn,
	Mvcc as MvccSnapshot,
	ResetTarget,
	Row as WireRow,
	ServerMessage,
} from "./wire-types.gen.js";
