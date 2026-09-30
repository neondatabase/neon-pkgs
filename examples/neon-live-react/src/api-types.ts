import type { LiveQueryAuthorization } from "@neon/live/client";

import type { Todo } from "./schema.js";

export type TodosAuthorization = LiveQueryAuthorization<Todo>;

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
