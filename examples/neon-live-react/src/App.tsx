import { useLiveQuery } from "@neon/live-react";
import {
	type FormEvent,
	startTransition,
	useActionState,
	useOptimistic,
} from "react";

import type {
	CreateTodoRequest,
	TodoMutationResponse,
	TodosAuthorization,
	UpdateTodoRequest,
} from "./api-types.js";
import type { Todo } from "./schema.js";

type TodoMutation =
	| {
			readonly type: "insert";
			readonly temporaryId: string;
			readonly title: string;
	  }
	| {
			readonly type: "set-status";
			readonly id: number;
			readonly status: Todo["status"];
	  }
	| { readonly type: "delete"; readonly id: number };

type OptimisticTodo = Omit<Todo, "id"> & {
	readonly id: number | string;
	readonly pending?: boolean;
};

const EMPTY_TODOS: readonly OptimisticTodo[] = Object.freeze([]);

export function TodoApp({
	authorization,
	refreshAuthorization,
}: {
	readonly authorization: TodosAuthorization;
	readonly refreshAuthorization: () => Promise<TodosAuthorization>;
}) {
	const {
		data: todos,
		status,
		error,
		utils,
	} = useLiveQuery(authorization, {
		refreshAuthorization,
	});
	const [optimisticTodos, applyOptimistic] = useOptimistic<
		readonly OptimisticTodo[],
		TodoMutation
	>(todos ?? EMPTY_TODOS, applyOptimisticTodoMutation);
	const [mutationError, dispatchMutation] = useActionState<
		string | undefined,
		TodoMutation
	>(async (_previousError, mutation) => {
		try {
			const result = await sendMutation(mutation);
			if (result.kind === "committed") await utils.awaitTxId(result.txid);
			return undefined;
		} catch (cause) {
			return message(cause);
		}
	}, undefined);

	function addTodo(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = event.currentTarget;
		const formData = new FormData(form);
		const title = String(formData.get("title") ?? "").trim();
		if (!title) return;
		form.reset();
		mutate({ type: "insert", temporaryId: crypto.randomUUID(), title });
	}

	function toggle(todo: OptimisticTodo) {
		if (typeof todo.id !== "number") return;
		mutate({
			type: "set-status",
			id: todo.id,
			status: todo.status === "completed" ? "active" : "completed",
		});
	}

	function deleteTodo(todo: OptimisticTodo) {
		if (typeof todo.id === "number")
			mutate({ type: "delete", id: todo.id });
	}

	function mutate(mutation: TodoMutation) {
		startTransition(() => {
			applyOptimistic(mutation);
			dispatchMutation(mutation);
		});
	}

	function sendMutation(
		mutation: TodoMutation,
	): Promise<TodoMutationResponse> {
		switch (mutation.type) {
			case "insert":
				return request("/api/todos", {
					method: "POST",
					body: JSON.stringify({
						title: mutation.title,
					} satisfies CreateTodoRequest),
				});
			case "set-status":
				return request(`/api/todos/${mutation.id}`, {
					method: "PATCH",
					body: JSON.stringify({
						status: mutation.status,
					} satisfies UpdateTodoRequest),
				});
			case "delete":
				return request(`/api/todos/${mutation.id}`, {
					method: "DELETE",
				});
		}
	}

	async function request<Result = unknown>(
		path: string,
		init: RequestInit,
	): Promise<Result> {
		const response = await fetch(path, {
			...init,
			headers: { "content-type": "application/json", ...init.headers },
		});
		if (!response.ok)
			throw new Error(`Request failed (${response.status})`);
		return response.json() as Promise<Result>;
	}

	return (
		<main>
			<header>
				<div>
					<p className="eyebrow">React</p>
					<h1>Neon Live Todos</h1>
				</div>
				<output className={`status ${status}`}>{status}</output>
			</header>

			<form onSubmit={addTodo}>
				<input name="title" placeholder="What needs doing?" required />
				<button type="submit">Add todo</button>
			</form>

			{(error || mutationError) && (
				<p className="error">{error?.message ?? mutationError}</p>
			)}

			<ul aria-live="polite">
				{optimisticTodos.map((todo) => (
					<li className={todo.status} key={todo.id}>
						<button
							aria-label={`Mark ${todo.title} ${todo.status === "completed" ? "active" : "completed"}`}
							className="toggle"
							disabled={todo.pending}
							onClick={() => toggle(todo)}
							type="button"
						>
							{todo.status === "completed" ? "✓" : "○"}
						</button>
						<span>{todo.title}</span>
						<button
							className="delete"
							disabled={todo.pending}
							onClick={() => deleteTodo(todo)}
							type="button"
						>
							Delete
						</button>
					</li>
				))}
			</ul>
		</main>
	);
}

function applyOptimisticTodoMutation(
	todos: readonly OptimisticTodo[],
	mutation: TodoMutation,
): readonly OptimisticTodo[] {
	switch (mutation.type) {
		case "insert":
			return [
				...todos,
				{
					id: mutation.temporaryId,
					title: mutation.title,
					status: "active",
					pending: true,
				},
			];
		case "set-status":
			return todos.map((todo) =>
				todo.id === mutation.id
					? {
							...todo,
							status: mutation.status,
						}
					: todo,
			);
		case "delete":
			return todos.filter((todo) => todo.id !== mutation.id);
	}
}

function message(cause: unknown): string {
	return cause instanceof Error ? cause.message : "Mutation failed";
}
