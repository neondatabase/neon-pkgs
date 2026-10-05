import type { SealedLiveQuery } from "@neon/realtime/client";

import type { Todo } from "./schema.js";

export type SealedTodosQuery = SealedLiveQuery<Todo>;

export interface CreateTodoRequest {
	readonly title: string;
}

export interface UpdateTodoRequest {
	readonly status: Todo["status"];
}

export interface CommittedTodoMutationResponse {
	readonly kind: "committed";
	readonly txid: string;
}

export type TodoMutationResponse =
	| CommittedTodoMutationResponse
	| {
			readonly kind: "unchanged";
	  };
