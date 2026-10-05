import "./style.css";

import { createRealtimeClient } from "@neon/realtime/client";
import { RealtimeProvider } from "@neon/realtime-react";
import { createRoot } from "react-dom/client";

import { TodoApp } from "./App.js";
import type { SealedTodosQuery } from "./api-types.js";

const websocketUrl = import.meta.env.VITE_NEON_REALTIME_URL;
if (!websocketUrl) throw new Error("Missing VITE_NEON_REALTIME_URL");

const client = createRealtimeClient({ url: websocketUrl });
const sealedQuery = await sealTodos();
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
	<RealtimeProvider client={client}>
		<TodoApp sealedQuery={sealedQuery} refreshQuery={sealTodos} />
	</RealtimeProvider>,
);

window.addEventListener("beforeunload", () => client.close());

async function sealTodos(): Promise<SealedTodosQuery> {
	const response = await fetch("/api/todos/live");
	if (!response.ok) throw new Error("Could not seal the todo query");
	return response.json() as Promise<SealedTodosQuery>;
}
