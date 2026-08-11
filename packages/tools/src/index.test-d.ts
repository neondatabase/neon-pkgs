import { expectTypeOf } from "vitest";
import { createNeonTool, createNeonTools } from "./index.js";

const tools = createNeonTools({
	apiKey: "test-key",
	operations: ["listProjects", "createProject"] as const,
});

expectTypeOf(tools).toHaveProperty("listProjects");
expectTypeOf(tools).toHaveProperty("createProject");

tools.listProjects.execute({ query: { limit: 1 } });
tools.createProject.execute({ body: { project: { name: "type-safe" } } });

// @ts-expect-error request input is inferred from the selected operation
tools.listProjects.execute({ query: { limit: "one" } });

const listProjects = createNeonTool("listProjects", { apiKey: "test-key" });
listProjects.execute({ query: { search: "demo" } });

// @ts-expect-error createNeonTool preserves the operation request schema
listProjects.execute({ body: { project: { name: "wrong-operation" } } });
