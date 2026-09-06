import { expectTypeOf } from "vitest";
import { toEveTool } from "./eve.js";
import {
	type CreateNeonToolsOptions,
	createNeonTool,
	createNeonTools,
	publishedId,
} from "./index.js";
import { toMastraTools } from "./mastra.js";

expectTypeOf(publishedId("projects.list")).toEqualTypeOf<"list_projects">();
expectTypeOf(
	publishedId("projects.createAndConnect"),
).toEqualTypeOf<"create_and_connect_projects">();
expectTypeOf(
	publishedId("postgres.roles.resetPassword"),
).toEqualTypeOf<"reset_password_postgres_roles">();
expectTypeOf(
	publishedId("branches.resetFromParent"),
).toEqualTypeOf<"reset_from_parent_branches">();
expectTypeOf(
	publishedId("branches.compareSchema"),
).toEqualTypeOf<"compare_schema_branches">();

const tools = createNeonTools({
	apiKey: "test-key",
	tools: ["projects.list", "projects.createAndConnect"] as const,
});

expectTypeOf(tools).toHaveProperty("projects.list");
expectTypeOf(tools).toHaveProperty("projects.createAndConnect");

tools["projects.list"].execute({ limit: 1 });
tools["projects.createAndConnect"].execute({ name: "type-safe" });
tools["projects.list"].execute({}).then((result) => {
	expectTypeOf(result.data[0]?.id).toEqualTypeOf<string>();
});

// @ts-expect-error request input is inferred from the selected tool
tools["projects.list"].execute({ limit: "one" });

const listProjects = createNeonTool("projects.list", { apiKey: "test-key" });
listProjects.execute({ search: "demo" });

const oauthTools = createNeonTools({
	tools: ["projects.list"] as const,
});
oauthTools["projects.list"].execute({}, { apiKey: "oauth-access-token" });
oauthTools["projects.list"].execute(
	{},
	{ apiKey: async () => "oauth-access-token" },
);

// @ts-expect-error createNeonTool preserves the request schema
listProjects.execute({ name: "wrong-operation" });

const mastraTools = toMastraTools(tools);
expectTypeOf(mastraTools).toHaveProperty("list_projects");
expectTypeOf(mastraTools).toHaveProperty("create_and_connect_projects");

// @ts-expect-error unselected tools are absent from the Mastra tool record
mastraTools.delete_projects;

const renamedMastra = toMastraTools(tools, {
	name: (tool) => `neon_${tool.id}`,
});
expectTypeOf(renamedMastra.neon_list_projects.id).toEqualTypeOf<string>();

// @ts-expect-error Mastra configs preserve tool-specific request types
mastraTools.list_projects.execute({ limit: "one" }, {});

const eveListProjects = toEveTool(tools["projects.list"]);
eveListProjects
	.execute({}, { abortSignal: new AbortController().signal })
	.then((result) => {
		expectTypeOf(result.data[0]?.id).toEqualTypeOf<string>();
	});

const resetFromParent = createNeonTool("branches.resetFromParent", {
	apiKey: "test-key",
});
resetFromParent.execute({
	project_id: "project-id",
	branch_id: "branch-id",
	preserve_under_name: "old",
});
const compareSchema = createNeonTool("branches.compareSchema", {
	apiKey: "test-key",
});
compareSchema.execute({
	project_id: "project-id",
	branch_id: "branch-id",
	database_name: "neondb",
	// @ts-expect-error compareSchema publishes database_name, not db_name
	db_name: "neondb",
});

const revokeCredential = createNeonTool("credentials.revoke", {
	apiKey: "test-key",
});
revokeCredential
	.execute({
		project_id: "project-id",
		branch_id: "branch-id",
		token_id: "token-id",
	})
	.then((result) => {
		expectTypeOf(result.data).toEqualTypeOf<null>();
	});

const omittedProject = createNeonTools({
	apiKey: "test-key",
	tools: ["projects.get"] as const,
	inject: { projectId: "granted-project", omitFromSchema: true },
});
omittedProject["projects.get"].execute({}).then((result) => {
	expectTypeOf(result.data.id).toEqualTypeOf<string>();
});

const filledProject = createNeonTools({
	apiKey: "test-key",
	tools: ["projects.get"] as const,
	inject: { projectId: "granted-project" },
});
filledProject["projects.get"].execute({});
filledProject["projects.get"].execute({ project_id: "caller-project" });

const omittedBranch = createNeonTools({
	apiKey: "test-key",
	tools: ["branches.delete"] as const,
	inject: { projectId: "granted-project", omitFromSchema: true },
});
omittedBranch["branches.delete"].execute({ branch_id: "br-id" });

// @ts-expect-error omitted project_id still requires the remaining path fields
omittedBranch["branches.delete"].execute({});

const eveOmitted = toEveTool(omittedProject["projects.get"]);
eveOmitted
	.execute({}, { abortSignal: new AbortController().signal })
	.then((result) => {
		expectTypeOf(result.data.id).toEqualTypeOf<string>();
	});

const mastraOmitted = toMastraTools(omittedProject);
mastraOmitted.get_projects.execute({}, {}).then((result) => {
	expectTypeOf(result.data.id).toEqualTypeOf<string>();
});

const omittedBoth = createNeonTools({
	apiKey: "test-key",
	tools: ["branches.delete"] as const,
	inject: {
		projectId: "granted-project",
		branchId: "granted-branch",
		omitFromSchema: true,
	},
});
omittedBoth["branches.delete"].execute({});

const omittedCreateNeonTool = createNeonTool("projects.get", {
	apiKey: "test-key",
	inject: { projectId: "granted-project", omitFromSchema: true },
});
omittedCreateNeonTool.execute({});

const describedOnly = createNeonTools({
	apiKey: "test-key",
	tools: ["projects.get"] as const,
	descriptions: { "projects.get": "Describe one project." },
});
// @ts-expect-error description overrides do not optionalize project_id
describedOnly["projects.get"].execute({});

const uninjectedProject = createNeonTool("projects.get", {
	apiKey: "test-key",
});
// @ts-expect-error project_id is required without inject
uninjectedProject.execute({});

const renamed = createNeonTools({
	apiKey: "test-key",
	tools: ["projects.list", "branches.createAndConnect"] as const,
	names: { "branches.createAndConnect": "create_branch" },
	name: (id) => `neon_${id}`,
});
expectTypeOf(renamed["projects.list"].id).toEqualTypeOf<string>();
expectTypeOf(renamed["branches.createAndConnect"].id).toEqualTypeOf<string>();
expectTypeOf(tools["projects.list"].id).toEqualTypeOf<"list_projects">();

const mastraRenamed = toMastraTools(renamed);
expectTypeOf(mastraRenamed.neon_create_branch.id).toEqualTypeOf<string>();
expectTypeOf(mastraRenamed.neon_list_projects.id).toEqualTypeOf<string>();

const renamedOne = createNeonTool("branches.createAndConnect", {
	apiKey: "test-key",
	names: { "branches.createAndConnect": "create_branch" },
});
expectTypeOf(renamedOne.id).toEqualTypeOf<string>();

const namedBag = {
	apiKey: "test-key",
	tools: ["projects.list"] as const,
	name: (id: string) => `neon_${id}`,
};
expectTypeOf(
	createNeonTools(namedBag)["projects.list"].id,
).toEqualTypeOf<string>();

const unnamedBag: CreateNeonToolsOptions<["projects.list"]> = {
	apiKey: "test-key",
	tools: ["projects.list"],
	// @ts-expect-error name is only on the rename overloads
	name: (id: string) => `neon_${id}`,
};
void unnamedBag;

const annotatedTools: CreateNeonToolsOptions<["projects.list"]> = {
	apiKey: "test-key",
	tools: ["projects.list"],
};
expectTypeOf(createNeonTools(annotatedTools)).toHaveProperty("projects.list");

const createBranch = createNeonTools({
	apiKey: "test-key",
	tools: ["branches.createAndConnect"] as const,
});
expectTypeOf(createBranch).toHaveProperty("branches.createAndConnect");
// @ts-expect-error unselected tools are absent
createBranch["projects.list"];
createBranch["branches.createAndConnect"].execute({
	project_id: "project-id",
});
// @ts-expect-error project_id is required without inject
createBranch["branches.createAndConnect"].execute({});
createBranch["branches.createAndConnect"]
	.execute({ project_id: "project-id" })
	.then((result) => {
		expectTypeOf(result.data.connectionString).toEqualTypeOf<string>();
		expectTypeOf(result.data.branch.id).toEqualTypeOf<string>();
	});

declare const unionOpts:
	| { apiKey: "test-key"; tools: ["projects.list"] }
	| { apiKey: "test-key"; tools: ["branches.createAndConnect"] };
const unionTools = createNeonTools(unionOpts);
// @ts-expect-error union options do not share projects.list
unionTools["projects.list"];
// @ts-expect-error union options do not share branches.createAndConnect
unionTools["branches.createAndConnect"];

const createBranchAndConnect = createNeonTool("branches.createAndConnect", {
	apiKey: "test-key",
});
createBranchAndConnect.execute({
	project_id: "project-id",
	name: "feature-x",
});
createBranchAndConnect.execute({
	project_id: "project-id",
	// @ts-expect-error parentId is not the tool field name
	parentId: "br-id",
});

const omittedWorkflow = createNeonTools({
	apiKey: "test-key",
	tools: ["branches.createAndConnect"] as const,
	inject: { projectId: "granted-project", omitFromSchema: true },
});
omittedWorkflow["branches.createAndConnect"].execute({ name: "feature-x" });

const createBranchOnly = createNeonTool("branches.create", {
	apiKey: "test-key",
});
createBranchOnly.execute({ project_id: "project-id", no_compute: true });
createBranchOnly.execute({ project_id: "project-id" }).then((result) => {
	expectTypeOf(result.data.id).toEqualTypeOf<string>();
	// @ts-expect-error create does not return a connection string
	result.data.connectionString;
});
// @ts-expect-error pooled is not on create
createBranchOnly.execute({ project_id: "project-id", pooled: false });
createBranchAndConnect.execute({
	project_id: "project-id",
	// @ts-expect-error no_compute is not on createAndConnect
	no_compute: true,
});

const createProjectOnly = createNeonTool("projects.create", {
	apiKey: "test-key",
});
createProjectOnly.execute({ name: "x" }).then((result) => {
	expectTypeOf(result.data.id).toEqualTypeOf<string>();
	// @ts-expect-error create does not return a connection string
	result.data.connectionString;
});
// @ts-expect-error no_compute is not on projects.create
createProjectOnly.execute({ name: "x", no_compute: true });

// @ts-expect-error tools is required
createNeonTools({ apiKey: "test-key" });
