import type { BetterFetchError } from "@better-fetch/fetch";
import type { Session, User } from "better-auth/types";

export type BetterAuthSession = Session;
export type BetterAuthUser = User;
export type BetterAuthErrorResponse = BetterFetchError;
