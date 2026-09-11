import * as z from "zod";
import { decodeBase64 } from "../binary.js";
import {
	bindTool,
	collectObjectList,
	collectPages,
	fromGenerated,
	publishedId,
	type ToolClientOptions,
} from "./bind.js";
import {
	compareSchemaTool,
	connectionStringTool,
	createBranchAndConnectTool,
	createBranchTool,
	createProjectAndConnectTool,
	createProjectTool,
	getDefaultTool,
	resetFromParentTool,
	restoreSnapshotTool,
	setScheduleTool,
} from "./composed.js";
import type { NeonToolId } from "./ids.js";

const logReadAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

export type ToolFactory = (typeof toolFactories)[NeonToolId];

export const toolFactories = {
	"projects.list": (options) =>
		fromGenerated(options, {
			id: "projects.list",
			generated: "listProjects",
			omit: ["cursor"],
			list: true,
			run: (neon, input, signal) =>
				collectPages(
					neon.projects.list(
						{
							limit: input.limit,
							search: input.search,
							org_id: input.org_id,
							timeout: input.timeout,
							recoverable: input.recoverable,
						},
						{ signal },
					),
					input.limit,
				),
		}),
	"projects.get": (options) =>
		fromGenerated(options, {
			id: "projects.get",
			generated: "getProject",
			run: (neon, input, signal) =>
				neon.projects.get({ projectId: input.project_id }, { signal }),
		}),
	"projects.create": createProjectTool,
	"projects.createAndConnect": createProjectAndConnectTool,
	"projects.update": (options) =>
		fromGenerated(options, {
			id: "projects.update",
			generated: "updateProject",
			run: (neon, input, signal) =>
				neon.projects.update(
					{
						projectId: input.project_id,
						settings: input.settings,
						name: input.name,
						default_endpoint_settings:
							input.default_endpoint_settings,
						history_retention_seconds:
							input.history_retention_seconds,
					},
					{ signal },
				),
		}),
	"projects.delete": (options) =>
		fromGenerated(options, {
			id: "projects.delete",
			generated: "deleteProject",
			run: (neon, input, signal) =>
				neon.projects.delete(
					{ projectId: input.project_id },
					{ signal },
				),
		}),
	"projects.recover": (options) =>
		fromGenerated(options, {
			id: "projects.recover",
			generated: "recoverProject",
			run: (neon, input, signal) =>
				neon.projects.recover(
					{ projectId: input.project_id },
					{ signal },
				),
		}),
	"projects.transfer": (options) =>
		fromGenerated(options, {
			id: "projects.transfer",
			generated: "transferProjectsFromOrgToOrg",
			run: (neon, input, signal) =>
				neon.projects.transfer(
					{
						fromOrgId: input.source_org_id,
						toOrgId: input.destination_org_id,
						projectIds: input.project_ids,
					},
					{ signal },
				),
		}),
	"projects.transferFromUser": (options) =>
		fromGenerated(options, {
			id: "projects.transferFromUser",
			generated: "transferProjectsFromUserToOrg",
			run: (neon, input, signal) =>
				neon.projects.transferFromUser(
					{
						toOrgId: input.destination_org_id,
						projectIds: input.project_ids,
					},
					{ signal },
				),
		}),
	"projects.permissions.list": (options) =>
		fromGenerated(options, {
			id: "projects.permissions.list",
			generated: "listProjectPermissions",
			run: (neon, input, signal) =>
				neon.projects.permissions.list(
					{ projectId: input.project_id },
					{ signal },
				),
		}),
	"projects.permissions.grant": (options) =>
		fromGenerated(options, {
			id: "projects.permissions.grant",
			generated: "grantPermissionToProject",
			run: (neon, input, signal) =>
				neon.projects.permissions.grant(
					{ projectId: input.project_id, email: input.email },
					{
						signal,
					},
				),
		}),
	"projects.permissions.revoke": (options) =>
		fromGenerated(options, {
			id: "projects.permissions.revoke",
			generated: "revokePermissionFromProject",
			run: (neon, input, signal) =>
				neon.projects.permissions.revoke(
					{
						projectId: input.project_id,
						permissionId: input.permission_id,
					},
					{ signal },
				),
		}),
	"projects.members.list": (options) =>
		fromGenerated(options, {
			id: "projects.members.list",
			generated: "listProjectMembers",
			omit: ["cursor"],
			list: true,
			run: (neon, input, signal) =>
				collectPages(
					neon.projects.members.list(
						{ projectId: input.project_id, limit: input.limit },
						{ signal },
					),
					input.limit,
				),
		}),
	"projects.members.setRole": (options) =>
		fromGenerated(options, {
			id: "projects.members.setRole",
			generated: "setProjectMemberRole",
			run: (neon, input, signal) =>
				neon.projects.members.setRole(
					{
						projectId: input.project_id,
						memberId: input.member_id,
						role: input.role,
						...(input.confirm_self_demotion
							? { confirmSelfDemotion: true }
							: {}),
					},
					{ signal },
				),
		}),
	"projects.members.removeRole": (options) =>
		fromGenerated(options, {
			id: "projects.members.removeRole",
			generated: "removeProjectMemberRole",
			run: (neon, input, signal) =>
				neon.projects.members.removeRole(
					{
						projectId: input.project_id,
						memberId: input.member_id,
						...(input.confirm_self_lockout
							? { confirmSelfLockout: true }
							: {}),
					},
					{ signal },
				),
		}),
	"branches.list": (options) =>
		fromGenerated(options, {
			id: "branches.list",
			generated: "listProjectBranches",
			omit: ["cursor"],
			list: true,
			run: (neon, input, signal) =>
				collectPages(
					neon.branches.list(
						{
							projectId: input.project_id,
							search: input.search,
							sort_by: input.sort_by,
							sort_order: input.sort_order,
							limit: input.limit,
							include_deleted: input.include_deleted,
						},
						{ signal },
					),
					input.limit,
				),
		}),
	"branches.get": (options) =>
		fromGenerated(options, {
			id: "branches.get",
			generated: "getProjectBranch",
			run: (neon, input, signal) =>
				neon.branches.get(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"branches.create": createBranchTool,
	"branches.createAndConnect": createBranchAndConnectTool,
	"branches.update": (options) =>
		fromGenerated(options, {
			id: "branches.update",
			generated: "updateProjectBranch",
			run: (neon, input, signal) =>
				neon.branches.update(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						name: input.name,
						protected: input.protected,
						expires_at: input.expires_at,
					},
					{ signal },
				),
		}),
	"branches.delete": (options) =>
		fromGenerated(options, {
			id: "branches.delete",
			generated: "deleteProjectBranch",
			run: (neon, input, signal) =>
				neon.branches.delete(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"branches.getDefault": getDefaultTool,
	"branches.setDefault": (options) =>
		fromGenerated(options, {
			id: "branches.setDefault",
			generated: "setDefaultProjectBranch",
			run: (neon, input, signal) =>
				neon.branches.setDefault(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"branches.resetFromParent": resetFromParentTool,
	"branches.compareSchema": compareSchemaTool,
	"branches.finalizeRestore": (options) =>
		fromGenerated(options, {
			id: "branches.finalizeRestore",
			generated: "finalizeRestoreBranch",
			run: (neon, input, signal) =>
				neon.branches.finalizeRestore(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						name: input.name,
					},
					{ signal },
				),
		}),
	"postgres.connectionString": connectionStringTool,
	"postgres.endpoints.list": (options) =>
		fromGenerated(options, {
			id: "postgres.endpoints.list",
			generated: "listProjectEndpoints",
			run: (neon, input, signal) =>
				neon.postgres.endpoints.list(
					{ projectId: input.project_id },
					{ signal },
				),
		}),
	"postgres.endpoints.listByBranch": (options) =>
		fromGenerated(options, {
			id: "postgres.endpoints.listByBranch",
			generated: "listProjectBranchEndpoints",
			run: (neon, input, signal) =>
				neon.postgres.endpoints.listByBranch(
					{ projectId: input.project_id, branchId: input.branch_id },
					{ signal },
				),
		}),
	"postgres.endpoints.get": (options) =>
		fromGenerated(options, {
			id: "postgres.endpoints.get",
			generated: "getProjectEndpoint",
			run: (neon, input, signal) =>
				neon.postgres.endpoints.get(
					{
						projectId: input.project_id,
						endpointId: input.endpoint_id,
					},
					{ signal },
				),
		}),
	"postgres.endpoints.create": (options) =>
		fromGenerated(options, {
			id: "postgres.endpoints.create",
			generated: "createProjectEndpoint",
			run: (neon, input, signal) =>
				neon.postgres.endpoints.create(
					{
						projectId: input.project_id,
						branch_id: input.branch_id,
						region_id: input.region_id,
						type: input.type,
						settings: input.settings,
						autoscaling_limit_min_cu:
							input.autoscaling_limit_min_cu,
						autoscaling_limit_max_cu:
							input.autoscaling_limit_max_cu,
						provisioner: input.provisioner,
						pooler_enabled: input.pooler_enabled,
						pooler_mode: input.pooler_mode,
						disabled: input.disabled,
						passwordless_access: input.passwordless_access,
						suspend_timeout_seconds: input.suspend_timeout_seconds,
						name: input.name,
					},
					{ signal },
				),
		}),
	"postgres.endpoints.update": (options) =>
		fromGenerated(options, {
			id: "postgres.endpoints.update",
			generated: "updateProjectEndpoint",
			run: (neon, input, signal) =>
				neon.postgres.endpoints.update(
					{
						projectId: input.project_id,
						endpointId: input.endpoint_id,
						branch_id: input.branch_id,
						autoscaling_limit_min_cu:
							input.autoscaling_limit_min_cu,
						autoscaling_limit_max_cu:
							input.autoscaling_limit_max_cu,
						provisioner: input.provisioner,
						settings: input.settings,
						pooler_enabled: input.pooler_enabled,
						pooler_mode: input.pooler_mode,
						disabled: input.disabled,
						passwordless_access: input.passwordless_access,
						suspend_timeout_seconds: input.suspend_timeout_seconds,
						name: input.name,
					},
					{ signal },
				),
		}),
	"postgres.endpoints.delete": (options) =>
		fromGenerated(options, {
			id: "postgres.endpoints.delete",
			generated: "deleteProjectEndpoint",
			run: (neon, input, signal) =>
				neon.postgres.endpoints.delete(
					{
						projectId: input.project_id,
						endpointId: input.endpoint_id,
					},
					{ signal },
				),
		}),
	"postgres.endpoints.start": (options) =>
		fromGenerated(options, {
			id: "postgres.endpoints.start",
			generated: "startProjectEndpoint",
			run: (neon, input, signal) =>
				neon.postgres.endpoints.start(
					{
						projectId: input.project_id,
						endpointId: input.endpoint_id,
					},
					{ signal },
				),
		}),
	"postgres.endpoints.suspend": (options) =>
		fromGenerated(options, {
			id: "postgres.endpoints.suspend",
			generated: "suspendProjectEndpoint",
			run: (neon, input, signal) =>
				neon.postgres.endpoints.suspend(
					{
						projectId: input.project_id,
						endpointId: input.endpoint_id,
					},
					{ signal },
				),
		}),
	"postgres.endpoints.restart": (options) =>
		fromGenerated(options, {
			id: "postgres.endpoints.restart",
			generated: "restartProjectEndpoint",
			run: (neon, input, signal) =>
				neon.postgres.endpoints.restart(
					{
						projectId: input.project_id,
						endpointId: input.endpoint_id,
					},
					{ signal },
				),
		}),
	"postgres.roles.list": (options) =>
		fromGenerated(options, {
			id: "postgres.roles.list",
			generated: "listProjectBranchRoles",
			run: (neon, input, signal) =>
				neon.postgres.roles.list(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"postgres.roles.get": (options) =>
		fromGenerated(options, {
			id: "postgres.roles.get",
			generated: "getProjectBranchRole",
			run: (neon, input, signal) =>
				neon.postgres.roles.get(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						roleName: input.role_name,
					},
					{ signal },
				),
		}),
	"postgres.roles.create": (options) =>
		fromGenerated(options, {
			id: "postgres.roles.create",
			generated: "createProjectBranchRole",
			run: (neon, input, signal) =>
				neon.postgres.roles.create(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						name: input.name,
						no_login: input.no_login,
					},
					{ signal },
				),
		}),
	"postgres.roles.delete": (options) =>
		fromGenerated(options, {
			id: "postgres.roles.delete",
			generated: "deleteProjectBranchRole",
			run: (neon, input, signal) =>
				neon.postgres.roles.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						roleName: input.role_name,
					},
					{ signal },
				),
		}),
	"postgres.roles.resetPassword": (options) =>
		fromGenerated(options, {
			id: "postgres.roles.resetPassword",
			generated: "resetProjectBranchRolePassword",
			run: (neon, input, signal) =>
				neon.postgres.roles.resetPassword(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						roleName: input.role_name,
					},
					{ signal },
				),
		}),
	"postgres.databases.list": (options) =>
		fromGenerated(options, {
			id: "postgres.databases.list",
			generated: "listProjectBranchDatabases",
			run: (neon, input, signal) =>
				neon.postgres.databases.list(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"postgres.databases.get": (options) =>
		fromGenerated(options, {
			id: "postgres.databases.get",
			generated: "getProjectBranchDatabase",
			run: (neon, input, signal) =>
				neon.postgres.databases.get(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						databaseName: input.database_name,
					},
					{ signal },
				),
		}),
	"postgres.databases.create": (options) =>
		fromGenerated(options, {
			id: "postgres.databases.create",
			generated: "createProjectBranchDatabase",
			run: (neon, input, signal) =>
				neon.postgres.databases.create(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						name: input.name,
						owner_name: input.owner_name,
					},
					{ signal },
				),
		}),
	"postgres.databases.update": (options) =>
		fromGenerated(options, {
			id: "postgres.databases.update",
			generated: "updateProjectBranchDatabase",
			run: (neon, input, signal) =>
				neon.postgres.databases.update(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						databaseName: input.database_name,
						name: input.name,
						owner_name: input.owner_name,
					},
					{ signal },
				),
		}),
	"postgres.databases.delete": (options) =>
		fromGenerated(options, {
			id: "postgres.databases.delete",
			generated: "deleteProjectBranchDatabase",
			run: (neon, input, signal) =>
				neon.postgres.databases.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						databaseName: input.database_name,
					},
					{ signal },
				),
		}),
	"postgres.dataApi.get": (options) =>
		fromGenerated(options, {
			id: "postgres.dataApi.get",
			generated: "getProjectBranchDataAPI",
			run: (neon, input, signal) =>
				neon.postgres.dataApi.get(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						databaseName: input.database_name,
					},
					{ signal },
				),
		}),
	"postgres.dataApi.create": (options) =>
		fromGenerated(options, {
			id: "postgres.dataApi.create",
			generated: "createProjectBranchDataAPI",
			run: (neon, input, signal) =>
				neon.postgres.dataApi.create(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						databaseName: input.database_name,
						auth_provider: input.auth_provider,
						jwks_url: input.jwks_url,
						provider_name: input.provider_name,
						jwt_audience: input.jwt_audience,
						add_default_grants: input.add_default_grants,
						skip_auth_schema: input.skip_auth_schema,
						settings: input.settings,
					},
					{ signal },
				),
		}),
	"postgres.dataApi.update": (options) =>
		fromGenerated(options, {
			id: "postgres.dataApi.update",
			generated: "updateProjectBranchDataAPI",
			run: (neon, input, signal) =>
				neon.postgres.dataApi.update(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						databaseName: input.database_name,
						settings: {
							db_aggregates_enabled: input.db_aggregates_enabled,
							db_anon_role: input.db_anon_role,
							db_extra_search_path: input.db_extra_search_path,
							db_max_rows: input.db_max_rows,
							db_schemas: input.db_schemas,
							jwt_role_claim_key: input.jwt_role_claim_key,
							jwt_cache_max_lifetime:
								input.jwt_cache_max_lifetime,
							openapi_mode: input.openapi_mode,
							server_cors_allowed_origins:
								input.server_cors_allowed_origins,
							server_timing_enabled: input.server_timing_enabled,
						},
					},
					{ signal },
				),
		}),
	"postgres.dataApi.delete": (options) =>
		fromGenerated(options, {
			id: "postgres.dataApi.delete",
			generated: "deleteProjectBranchDataAPI",
			run: (neon, input, signal) =>
				neon.postgres.dataApi.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						databaseName: input.database_name,
					},
					{ signal },
				),
		}),
	"storage.get": (options) =>
		fromGenerated(options, {
			id: "storage.get",
			generated: "getProjectBranchStorage",
			run: (neon, input, signal) =>
				neon.storage.get(
					{ projectId: input.project_id, branchId: input.branch_id },
					{ signal },
				),
		}),
	"storage.buckets.list": (options) =>
		fromGenerated(options, {
			id: "storage.buckets.list",
			generated: "listProjectBranchBuckets",
			run: (neon, input, signal) =>
				neon.storage.buckets.list(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"storage.buckets.create": (options) =>
		fromGenerated(options, {
			id: "storage.buckets.create",
			generated: "createProjectBranchBucket",
			run: (neon, input, signal) =>
				neon.storage.buckets.create(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						name: input.name,
						access_level: input.access_level,
					},
					{ signal },
				),
		}),
	"storage.buckets.delete": (options) =>
		fromGenerated(options, {
			id: "storage.buckets.delete",
			generated: "deleteProjectBranchBucket",
			run: (neon, input, signal) =>
				neon.storage.buckets.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						bucketName: input.bucket_name,
					},
					{ signal },
				),
		}),
	"storage.objects.list": (options) =>
		fromGenerated(options, {
			id: "storage.objects.list",
			generated: "listProjectBranchBucketObjects",
			omit: ["cursor"],
			list: true,
			run: (neon, input, signal) =>
				collectObjectList(
					neon,
					{
						project_id: input.project_id,
						branch_id: input.branch_id,
						bucket_name: input.bucket_name,
						prefix: input.prefix,
						delimiter: input.delimiter,
						limit: input.limit,
					},
					signal,
				),
		}),
	"storage.objects.delete": (options) =>
		fromGenerated(options, {
			id: "storage.objects.delete",
			generated: "deleteProjectBranchBucketObject",
			run: (neon, input, signal) =>
				neon.storage.objects.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						bucketName: input.bucket_name,
						objectKey: input.object_key,
					},
					{ signal },
				),
		}),
	"storage.objects.deleteByPrefix": (options) =>
		fromGenerated(options, {
			id: "storage.objects.deleteByPrefix",
			generated: "deleteProjectBranchBucketObjectsByPrefix",
			run: (neon, input, signal) =>
				neon.storage.objects.deleteByPrefix(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						bucketName: input.bucket_name,
						prefix: input.prefix,
					},
					{ signal },
				),
		}),
	"storage.objects.presign": (options) =>
		fromGenerated(options, {
			id: "storage.objects.presign",
			generated: "presignProjectBranchBucketObject",
			run: (neon, input, signal) =>
				neon.storage.objects.presign(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						bucketName: input.bucket_name,
						objectKey: input.object_key,
						operation: input.operation,
						content_type: input.content_type,
						expires_in_seconds: input.expires_in_seconds,
					},
					{ signal },
				),
		}),
	"functions.list": (options) =>
		fromGenerated(options, {
			id: "functions.list",
			generated: "listProjectBranchFunctions",
			omit: ["cursor"],
			list: true,
			run: (neon, input, signal) =>
				collectPages(
					neon.functions.list(
						{
							projectId: input.project_id,
							branchId: input.branch_id,
							limit: input.limit,
						},
						{ signal },
					),
					input.limit,
				),
		}),
	"functions.get": (options) =>
		fromGenerated(options, {
			id: "functions.get",
			generated: "getProjectBranchFunction",
			run: (neon, input, signal) =>
				neon.functions.get(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						slug: input.slug,
					},
					{ signal },
				),
		}),
	"functions.update": (options) =>
		fromGenerated(options, {
			id: "functions.update",
			generated: "updateProjectBranchFunction",
			run: (neon, input, signal) =>
				neon.functions.update(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						slug: input.slug,
						name: input.name,
					},
					{ signal },
				),
		}),
	"functions.delete": (options) =>
		fromGenerated(options, {
			id: "functions.delete",
			generated: "deleteProjectBranchFunction",
			run: (neon, input, signal) =>
				neon.functions.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						slug: input.slug,
					},
					{ signal },
				),
		}),
	"functions.deploy": (options) =>
		fromGenerated(options, {
			id: "functions.deploy",
			generated: "createProjectBranchFunctionDeployment",
			run: (neon, input, signal) =>
				neon.functions.deploy(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						slug: input.slug,
						zip:
							input.zip === undefined
								? undefined
								: decodeBase64(input.zip),
						runtime: input.runtime,
						environment: input.environment,
					},
					{ signal },
				),
		}),
	"functions.customDomains.list": (options) =>
		fromGenerated(options, {
			id: "functions.customDomains.list",
			generated: "listProjectBranchCustomDomains",
			omit: ["cursor"],
			list: true,
			run: (neon, input, signal) =>
				collectPages(
					neon.functions.customDomains.list(
						{
							projectId: input.project_id,
							branchId: input.branch_id,
							limit: input.limit,
						},
						{ signal },
					),
					input.limit,
				),
		}),
	"functions.customDomains.register": (options) =>
		fromGenerated(options, {
			id: "functions.customDomains.register",
			generated: "registerProjectBranchCustomDomain",
			run: (neon, input, signal) =>
				neon.functions.customDomains.register(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						domain: input.domain,
						entity_type: input.entity_type,
						entity_id: input.entity_id,
					},
					{ signal },
				),
		}),
	"functions.customDomains.delete": (options) =>
		fromGenerated(options, {
			id: "functions.customDomains.delete",
			generated: "deleteProjectBranchCustomDomain",
			run: (neon, input, signal) =>
				neon.functions.customDomains.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						domain: input.domain,
					},
					{ signal },
				),
		}),
	"triggers.list": (options) =>
		fromGenerated(options, {
			id: "triggers.list",
			generated: "listProjectBranchTriggers",
			run: (neon, input, signal) =>
				neon.triggers.list(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"triggers.get": (options) =>
		fromGenerated(options, {
			id: "triggers.get",
			generated: "getProjectBranchTrigger",
			run: (neon, input, signal) =>
				neon.triggers.get(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						triggerId: input.trigger_id,
					},
					{ signal },
				),
		}),
	"triggers.create": (options) =>
		fromGenerated(options, {
			id: "triggers.create",
			generated: "createProjectBranchTrigger",
			run: (neon, input, signal) =>
				neon.triggers.create(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						...input.body,
					},
					{ signal },
				),
		}),
	"triggers.update": (options) =>
		fromGenerated(options, {
			id: "triggers.update",
			generated: "updateProjectBranchTrigger",
			run: (neon, input, signal) =>
				neon.triggers.update(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						triggerId: input.trigger_id,
						...input.body,
					},
					{ signal },
				),
		}),
	"triggers.delete": (options) =>
		fromGenerated(options, {
			id: "triggers.delete",
			generated: "deleteProjectBranchTrigger",
			run: (neon, input, signal) =>
				neon.triggers.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						triggerId: input.trigger_id,
					},
					{ signal },
				),
		}),
	"credentials.list": (options) =>
		fromGenerated(options, {
			id: "credentials.list",
			generated: "listCredentials",
			run: (neon, input, signal) =>
				neon.credentials.list(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"credentials.create": (options) =>
		fromGenerated(options, {
			id: "credentials.create",
			generated: "createCredential",
			run: (neon, input, signal) =>
				neon.credentials.create(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						name: input.name,
						scopes: input.scopes,
						principal_type: input.principal_type,
					},
					{ signal },
				),
		}),
	"credentials.revoke": (options) =>
		fromGenerated(options, {
			id: "credentials.revoke",
			generated: "revokeCredential",
			run: (neon, input, signal) =>
				neon.credentials.revoke(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						tokenId: input.token_id,
					},
					{ signal },
				),
		}),
	"credentials.rotate": (options) =>
		fromGenerated(options, {
			id: "credentials.rotate",
			generated: "rotateCredential",
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
			run: (neon, input, signal) =>
				neon.credentials.rotate(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						tokenId: input.token_id,
					},
					{ signal },
				),
		}),
	"aiGateway.get": (options) =>
		fromGenerated(options, {
			id: "aiGateway.get",
			generated: "getProjectBranchAiGateway",
			run: (neon, input, signal) =>
				neon.aiGateway.get(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"logs.query": (options) =>
		fromGenerated(options, {
			id: "logs.query",
			generated: "queryProjectBranchLogs",
			omit: ["cursor"],
			list: true,
			annotations: logReadAnnotations,
			requiresApproval: false,
			run: (neon, input, signal) =>
				collectPages(
					neon.logs.query(
						{
							projectId: input.project_id,
							branchId: input.branch_id,
							since: input.since,
							start_time: input.start_time,
							end_time: input.end_time,
							limit: input.limit,
							sort_order: input.sort_order,
							source: input.source,
							service_name: input.service_name,
							scope_name: input.scope_name,
							minimum_severity: input.minimum_severity,
							severity_text: input.severity_text,
							body_contains: input.body_contains,
							trace_id: input.trace_id,
							logql: input.logql,
						},
						{ signal },
					),
					input.limit,
				),
		}),
	"logs.fields": (options) =>
		fromGenerated(options, {
			id: "logs.fields",
			generated: "listProjectBranchLogFields",
			run: (neon, input, signal) =>
				neon.logs.fields(
					{ projectId: input.project_id, branchId: input.branch_id },
					{ signal },
				),
		}),
	"logs.fieldValues": (options) =>
		fromGenerated(options, {
			id: "logs.fieldValues",
			generated: "listProjectBranchLogFieldValues",
			run: (neon, input, signal) =>
				neon.logs.fieldValues(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						fieldName: input.field_name,
						since: input.since,
						start_time: input.start_time,
						end_time: input.end_time,
						source: input.source,
						limit: input.limit,
					},
					{ signal },
				),
		}),
	"snapshots.list": (options) =>
		fromGenerated(options, {
			id: "snapshots.list",
			generated: "listSnapshots",
			run: (neon, input, signal) =>
				neon.snapshots.list(
					{ projectId: input.project_id },
					{ signal },
				),
		}),
	"snapshots.create": (options) =>
		fromGenerated(options, {
			id: "snapshots.create",
			generated: "createSnapshot",
			run: (neon, input, signal) =>
				neon.snapshots.create(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						name: input.name,
						timestamp: input.timestamp,
						lsn: input.lsn,
						expiresAt: input.expires_at,
					},
					{ signal },
				),
		}),
	"snapshots.update": (options) =>
		fromGenerated(options, {
			id: "snapshots.update",
			generated: "updateSnapshot",
			run: (neon, input, signal) =>
				neon.snapshots.update(
					{
						projectId: input.project_id,
						snapshotId: input.snapshot_id,
						name: input.name,
						expiresAt: input.expires_at,
					},
					{ signal },
				),
		}),
	"snapshots.delete": (options) =>
		fromGenerated(options, {
			id: "snapshots.delete",
			generated: "deleteSnapshot",
			run: (neon, input, signal) =>
				neon.snapshots.delete(
					{
						projectId: input.project_id,
						snapshotId: input.snapshot_id,
					},
					{
						signal,
					},
				),
		}),
	"snapshots.restore": restoreSnapshotTool,
	"snapshots.getSchedule": (options) =>
		fromGenerated(options, {
			id: "snapshots.getSchedule",
			generated: "getSnapshotSchedule",
			run: (neon, input, signal) =>
				neon.snapshots.getSchedule(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"snapshots.setSchedule": setScheduleTool,
	"operations.list": (options) =>
		fromGenerated(options, {
			id: "operations.list",
			generated: "listProjectOperations",
			omit: ["cursor"],
			list: true,
			run: (neon, input, signal) =>
				collectPages(
					neon.operations.list(
						{ projectId: input.project_id },
						{ signal },
					),
					input.limit,
				),
		}),
	"operations.get": (options) =>
		fromGenerated(options, {
			id: "operations.get",
			generated: "getProjectOperation",
			run: (neon, input, signal) =>
				neon.operations.get(
					{
						projectId: input.project_id,
						operationId: input.operation_id,
					},
					{
						signal,
					},
				),
		}),
	"auth.get": (options) =>
		fromGenerated(options, {
			id: "auth.get",
			generated: "getNeonAuth",
			run: (neon, input, signal) =>
				neon.auth.get(
					{ projectId: input.project_id, branchId: input.branch_id },
					{ signal },
				),
		}),
	"auth.create": (options) =>
		fromGenerated(options, {
			id: "auth.create",
			generated: "createNeonAuth",
			run: (neon, input, signal) =>
				neon.auth.create(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						auth_provider: input.auth_provider,
						database_name: input.database_name,
					},
					{ signal },
				),
		}),
	"auth.disable": (options) =>
		fromGenerated(options, {
			id: "auth.disable",
			generated: "disableNeonAuth",
			run: (neon, input, signal) =>
				neon.auth.disable(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						deleteData: input.delete_data,
					},
					{ signal },
				),
		}),
	"auth.updateConfig": (options) =>
		fromGenerated(options, {
			id: "auth.updateConfig",
			generated: "updateNeonAuthConfig",
			run: (neon, input, signal) =>
				neon.auth.updateConfig(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						name: input.name,
					},
					{ signal },
				),
		}),
	"auth.oauthProviders.list": (options) =>
		fromGenerated(options, {
			id: "auth.oauthProviders.list",
			generated: "listBranchNeonAuthOauthProviders",
			run: (neon, input, signal) =>
				neon.auth.oauthProviders.list(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"auth.oauthProviders.add": (options) =>
		fromGenerated(options, {
			id: "auth.oauthProviders.add",
			generated: "addBranchNeonAuthOauthProvider",
			run: (neon, input, signal) =>
				neon.auth.oauthProviders.add(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						id: input.id,
						client_id: input.client_id,
						client_secret: input.client_secret,
						microsoft_tenant_id: input.microsoft_tenant_id,
					},
					{ signal },
				),
		}),
	"auth.oauthProviders.update": (options) =>
		fromGenerated(options, {
			id: "auth.oauthProviders.update",
			generated: "updateBranchNeonAuthOauthProvider",
			run: (neon, input, signal) =>
				neon.auth.oauthProviders.update(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						providerId: input.oauth_provider_id,
						client_id: input.client_id,
						client_secret: input.client_secret,
						microsoft_tenant_id: input.microsoft_tenant_id,
					},
					{ signal },
				),
		}),
	"auth.oauthProviders.delete": (options) =>
		fromGenerated(options, {
			id: "auth.oauthProviders.delete",
			generated: "deleteBranchNeonAuthOauthProvider",
			run: (neon, input, signal) =>
				neon.auth.oauthProviders.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						providerId: input.oauth_provider_id,
					},
					{ signal },
				),
		}),
	"auth.trustedDomains.list": (options) =>
		fromGenerated(options, {
			id: "auth.trustedDomains.list",
			generated: "listBranchNeonAuthTrustedDomains",
			run: (neon, input, signal) =>
				neon.auth.trustedDomains.list(
					{ projectId: input.project_id, branchId: input.branch_id },
					{
						signal,
					},
				),
		}),
	"auth.trustedDomains.add": (options) =>
		fromGenerated(options, {
			id: "auth.trustedDomains.add",
			generated: "addBranchNeonAuthTrustedDomain",
			run: (neon, input, signal) =>
				neon.auth.trustedDomains.add(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						domain: input.domain,
						auth_provider: input.auth_provider,
					},
					{ signal },
				),
		}),
	"auth.trustedDomains.delete": (options) =>
		fromGenerated(options, {
			id: "auth.trustedDomains.delete",
			generated: "deleteBranchNeonAuthTrustedDomain",
			run: (neon, input, signal) =>
				neon.auth.trustedDomains.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						auth_provider: input.auth_provider,
						domains: input.domains,
					},
					{ signal },
				),
		}),
	"auth.users.create": (options) =>
		fromGenerated(options, {
			id: "auth.users.create",
			generated: "createBranchNeonAuthNewUser",
			run: (neon, input, signal) =>
				neon.auth.users.create(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						email: input.email,
						name: input.name,
					},
					{ signal },
				),
		}),
	"auth.users.delete": (options) =>
		fromGenerated(options, {
			id: "auth.users.delete",
			generated: "deleteBranchNeonAuthUser",
			run: (neon, input, signal) =>
				neon.auth.users.delete(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						authUserId: input.auth_user_id,
					},
					{ signal },
				),
		}),
	"auth.users.updateRole": (options) =>
		fromGenerated(options, {
			id: "auth.users.updateRole",
			generated: "updateNeonAuthUserRole",
			run: (neon, input, signal) =>
				neon.auth.users.updateRole(
					{
						projectId: input.project_id,
						branchId: input.branch_id,
						authUserId: input.auth_user_id,
						roles: input.roles,
					},
					{ signal },
				),
		}),
	"consumption.perProject": (options) =>
		fromGenerated(options, {
			id: "consumption.perProject",
			generated: "getConsumptionHistoryPerProject",
			omit: ["cursor"],
			list: true,
			run: (neon, input, signal) =>
				collectPages(
					neon.consumption.perProject(
						{
							limit: input.limit,
							project_ids: input.project_ids,
							from: input.from,
							to: input.to,
							granularity: input.granularity,
							org_id: input.org_id,
							include_v1_metrics: input.include_v1_metrics,
							metrics: input.metrics,
						},
						{ signal },
					),
					input.limit,
				),
		}),
	"consumption.perProjectV2": (options) =>
		fromGenerated(options, {
			id: "consumption.perProjectV2",
			generated: "getConsumptionHistoryPerProjectV2",
			omit: ["cursor"],
			list: true,
			run: (neon, input, signal) =>
				collectPages(
					neon.consumption.perProjectV2(
						{
							limit: input.limit,
							project_ids: input.project_ids,
							from: input.from,
							to: input.to,
							granularity: input.granularity,
							org_id: input.org_id,
							metrics: input.metrics,
						},
						{ signal },
					),
					input.limit,
				),
		}),
	"consumption.perBranchV2": (options) =>
		fromGenerated(options, {
			id: "consumption.perBranchV2",
			generated: "getConsumptionHistoryPerBranchV2",
			omit: ["cursor"],
			list: true,
			run: (neon, input, signal) =>
				collectPages(
					neon.consumption.perBranchV2(
						{
							limit: input.limit,
							project_ids: input.project_ids,
							branch_ids: input.branch_ids,
							from: input.from,
							to: input.to,
							granularity: input.granularity,
							org_id: input.org_id,
							metrics: input.metrics,
						},
						{ signal },
					),
					input.limit,
				),
		}),
	"apiKeys.list": (options) =>
		fromGenerated(options, {
			id: "apiKeys.list",
			generated: "listApiKeys",
			run: (neon, _input, signal) => neon.apiKeys.list({ signal }),
		}),
	"apiKeys.create": (options) =>
		fromGenerated(options, {
			id: "apiKeys.create",
			generated: "createApiKey",
			run: (neon, input, signal) =>
				neon.apiKeys.create({ keyName: input.key_name }, { signal }),
		}),
	"apiKeys.revoke": (options) =>
		fromGenerated(options, {
			id: "apiKeys.revoke",
			generated: "revokeApiKey",
			run: (neon, input, signal) =>
				neon.apiKeys.revoke({ keyId: input.key_id }, { signal }),
		}),
	"regions.list": (options) =>
		bindTool(
			options,
			{
				operationId: "regions.list",
				id: publishedId("regions.list"),
				title: "List regions",
				description:
					"Lists Neon regions available to the authenticated account.",
				inputSchema: z.strictObject({}),
				annotations: { readOnlyHint: true, openWorldHint: false },
				requiresApproval: false,
				metadata: {
					method: "GET",
					path: "/regions",
					stability: "stable",
					deprecated: false,
					tags: ["Region"],
				},
			},
			(neon, _input, signal) => neon.regions.list({ signal }),
		),
	"user.me": (options) =>
		fromGenerated(options, {
			id: "user.me",
			generated: "getCurrentUserInfo",
			run: (neon, _input, signal) => neon.user.me({ signal }),
		}),
	"user.organizations": (options) =>
		fromGenerated(options, {
			id: "user.organizations",
			generated: "getCurrentUserOrganizations",
			run: (neon, _input, signal) => neon.user.organizations({ signal }),
		}),
} satisfies Record<NeonToolId, (options: ToolClientOptions) => unknown>;
