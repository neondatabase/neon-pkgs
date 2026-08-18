import { expectTypeOf } from "vitest";
import { toEveTool } from "./eve.js";
import { createNeonTool, createNeonTools } from "./index.js";
import { toMastraTools } from "./mastra.js";

const tools = createNeonTools({
	apiKey: "test-key",
	operations: ["listProjects", "createProject"] as const,
});

expectTypeOf(tools).toHaveProperty("listProjects");
expectTypeOf(tools).toHaveProperty("createProject");

tools.listProjects.execute({ query: { limit: 1 } });
tools.createProject.execute({ body: { project: { name: "type-safe" } } });
tools.listProjects.execute({}).then((result) => {
	expectTypeOf(result.data.projects[0]?.id).toEqualTypeOf<string>();
});

// @ts-expect-error request input is inferred from the selected operation
tools.listProjects.execute({ query: { limit: "one" } });

const listProjects = createNeonTool("listProjects", { apiKey: "test-key" });
listProjects.execute({ query: { search: "demo" } });

const oauthTools = createNeonTools({
	operations: ["listProjects"] as const,
});
oauthTools.listProjects.execute({}, { apiKey: "oauth-access-token" });
oauthTools.listProjects.execute(
	{},
	{ apiKey: async () => "oauth-access-token" },
);

// @ts-expect-error createNeonTool preserves the operation request schema
listProjects.execute({ body: { project: { name: "wrong-operation" } } });

const mastraTools = toMastraTools(tools);
expectTypeOf(mastraTools).toHaveProperty("list_projects");
expectTypeOf(mastraTools).toHaveProperty("create_project");

// @ts-expect-error unselected operations are absent from the Mastra tool record
mastraTools.delete_project;

// @ts-expect-error Mastra configs preserve operation-specific request types
mastraTools.list_projects.execute({ query: { limit: "one" } }, {});

mastraTools.list_projects.execute({}, {}).then((result) => {
	expectTypeOf(result.data.projects[0]?.id).toEqualTypeOf<string>();
});

const eveListProjects = toEveTool(tools.listProjects);
eveListProjects
	.execute({}, { abortSignal: new AbortController().signal })
	.then((result) => {
		expectTypeOf(result.data.projects[0]?.id).toEqualTypeOf<string>();
	});

const bucketObject = createNeonTool("getProjectBranchBucketObject", {
	apiKey: "test-key",
});
bucketObject
	.execute({
		path: {
			project_id: "project-id",
			branch_id: "branch-id",
			bucket_name: "bucket",
			object_key: "key",
		},
	})
	.then((result) => {
		expectTypeOf(result.data.base64).toEqualTypeOf<string>();
		expectTypeOf(result.data.size).toEqualTypeOf<number>();
	});

const revokeCredential = createNeonTool("revokeCredential", {
	apiKey: "test-key",
});
revokeCredential
	.execute({
		path: {
			project_id: "project-id",
			branch_id: "branch-id",
			token_id: "token-id",
		},
	})
	.then((result) => {
		expectTypeOf(result.data).toEqualTypeOf<null>();
	});

const omittedProject = createNeonTools({
	apiKey: "test-key",
	operations: ["getProject"] as const,
	inject: { projectId: "granted-project", omitFromSchema: true },
});
omittedProject.getProject.execute({}).then((result) => {
	expectTypeOf(result.data.project.id).toEqualTypeOf<string>();
});

const filledProject = createNeonTools({
	apiKey: "test-key",
	operations: ["getProject"] as const,
	inject: { projectId: "granted-project" },
});
filledProject.getProject.execute({});
filledProject.getProject.execute({ path: { project_id: "caller-project" } });

const omittedBranch = createNeonTools({
	apiKey: "test-key",
	operations: ["deleteProjectBranch"] as const,
	inject: { projectId: "granted-project", omitFromSchema: true },
});
omittedBranch.deleteProjectBranch.execute({ path: { branch_id: "br-id" } });

// @ts-expect-error omitted project_id still requires the remaining path fields
omittedBranch.deleteProjectBranch.execute({});

const eveOmitted = toEveTool(omittedProject.getProject);
eveOmitted
	.execute({}, { abortSignal: new AbortController().signal })
	.then((result) => {
		expectTypeOf(result.data.project.id).toEqualTypeOf<string>();
	});

const mastraOmitted = toMastraTools(omittedProject);
mastraOmitted.get_project.execute({}, {}).then((result) => {
	expectTypeOf(result.data.project.id).toEqualTypeOf<string>();
});

const omittedBoth = createNeonTools({
	apiKey: "test-key",
	operations: ["deleteProjectBranch"] as const,
	inject: {
		projectId: "granted-project",
		branchId: "granted-branch",
		omitFromSchema: true,
	},
});
omittedBoth.deleteProjectBranch.execute({});

const omittedCreateNeonTool = createNeonTool("getProject", {
	apiKey: "test-key",
	inject: { projectId: "granted-project", omitFromSchema: true },
});
omittedCreateNeonTool.execute({});

const describedOnly = createNeonTools({
	apiKey: "test-key",
	operations: ["getProject"] as const,
	descriptions: { getProject: "Describe one project." },
});
// @ts-expect-error description overrides do not optionalize path
describedOnly.getProject.execute({});

const uninjectedProject = createNeonTool("getProject", { apiKey: "test-key" });
// @ts-expect-error path.project_id is required without inject
uninjectedProject.execute({});
