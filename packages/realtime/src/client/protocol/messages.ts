import type { Column, ServerMessage } from "./wire-types.gen.js";

export const REALTIME_SUBPROTOCOL = "neon.realtime.v1";

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
