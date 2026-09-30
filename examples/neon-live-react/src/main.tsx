import "./style.css";

import { createNeonLiveClient } from "@neon/live/client";
import { NeonLiveProvider } from "@neon/live-react";
import { createRoot } from "react-dom/client";

import { TodoApp } from "./App.js";
import type { TodosAuthorization } from "./api-types.js";

const websocketUrl = import.meta.env.VITE_NEON_LIVE_URL;
if (!websocketUrl) throw new Error("Missing VITE_NEON_LIVE_URL");

const client = createNeonLiveClient({ url: websocketUrl });
const authorization = await authorizeTodos();
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");

createRoot(root).render(
	<NeonLiveProvider client={client}>
		<TodoApp
			authorization={authorization}
			refreshAuthorization={authorizeTodos}
		/>
	</NeonLiveProvider>,
);

window.addEventListener("beforeunload", () => client.close());

async function authorizeTodos(): Promise<TodosAuthorization> {
	const response = await fetch("/api/todos/live");
	if (!response.ok) throw new Error("Could not authorize the todo query");
	return response.json() as Promise<TodosAuthorization>;
}
