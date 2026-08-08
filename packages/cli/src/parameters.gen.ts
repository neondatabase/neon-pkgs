// FILE IS GENERATED, DO NOT EDIT

export const projectCreateRequest = {
  'project.settings.quota.active_time_seconds': {
              type: "number",
              description: "The total amount of wall-clock time allowed to be spent by the project's compute endpoints.\n",
              demandOption: false,
  },
  'project.settings.quota.compute_time_seconds': {
              type: "number",
              description: "The total amount of CPU seconds allowed to be spent by the project's compute endpoints.\n",
              demandOption: false,
  },
  'project.settings.quota.written_data_bytes': {
              type: "number",
              description: "Total amount of data written to all of a project's branches.\n",
              demandOption: false,
  },
  'project.settings.quota.data_transfer_bytes': {
              type: "number",
              description: "Total amount of data transferred from all of a project's branches using the proxy.\n",
              demandOption: false,
  },
  'project.settings.quota.logical_size_bytes': {
              type: "number",
              description: "Limit on the logical size of every project's branch.\n\nIf a branch exceeds its `logical_size_bytes` quota, computes can still be started,\nbut write operations will fail—allowing data to be deleted to free up space.\nComputes on other branches are not affected.\n\nSetting `logical_size_bytes` overrides any lower value set by the `neon.max_cluster_size` Postgres setting.\n",
              demandOption: false,
  },
  'project.settings.allowed_ips.ips': {
              type: "array",
              description: "A list of IP addresses that are allowed to connect to the endpoint.",
              demandOption: false,
  },
  'project.settings.allowed_ips.protected_branches_only': {
              type: "boolean",
              description: "If true, the list will be applied only to protected branches.",
              demandOption: false,
  },
  'project.settings.enable_logical_replication': {
              type: "boolean",
              description: "Sets wal_level=logical for all compute endpoints in this project.\nAll active endpoints will be suspended.\nOnce enabled, logical replication cannot be disabled.\n",
              demandOption: false,
  },
  'project.settings.maintenance_window.weekdays': {
              type: "array",
              description: "A list of weekdays when the maintenance window is active.\nEncoded as ints, where 1 - Monday, and 7 - Sunday.\n",
              demandOption: true,
  },
  'project.settings.maintenance_window.start_time': {
              type: "string",
              description: "Start time of the maintenance window, in the format of \"HH:MM\". Uses UTC.\n",
              demandOption: true,
  },
  'project.settings.maintenance_window.end_time': {
              type: "string",
              description: "End time of the maintenance window, in the format of \"HH:MM\". Uses UTC.\n",
              demandOption: true,
  },
  'project.settings.block_public_connections': {
              type: "boolean",
              description: "When set, connections from the public internet\nare disallowed. This supersedes the AllowedIPs list.\nThis parameter is under active development and its semantics may change in the future.\n",
              demandOption: false,
  },
  'project.settings.block_vpc_connections': {
              type: "boolean",
              description: "When set, connections using VPC endpoints are disallowed.\nThis parameter is under active development and its semantics may change in the future.\n",
              demandOption: false,
  },
  'project.settings.audit_log_level': {
              type: "string",
              description: "Audit logging level, set only on HIPAA-enabled organizations (absent otherwise). Values: `base`, `extended`, `full`; HIPAA defaults to `extended`. Cannot be lowered back to `base` once `extended` or `full`.",
              demandOption: false,
 choices: ["base","extended","full"],
  },
  'project.settings.hipaa': {
              type: "boolean",
              description: "Enables HIPAA compliance mode for the project, including audit logging.",
              demandOption: false,
  },
  'project.settings.preload_libraries.use_defaults': {
              type: "boolean",
              description: "When true, the project's preload libraries include the platform default set in addition to any libraries listed in `enabled_libraries`.",
              demandOption: false,
  },
  'project.settings.preload_libraries.enabled_libraries': {
              type: "array",
              description: "Names of shared preload libraries to enable for the project.",
              demandOption: false,
  },
  'project.name': {
              type: "string",
              description: "The project name. If not specified, the name will be identical to the generated project ID",
              demandOption: false,
  },
  'project.branch.name': {
              type: "string",
              description: "The default branch name. If not specified, the default branch name, `main`, will be used.\n",
              demandOption: false,
  },
  'project.branch.role_name': {
              type: "string",
              description: "The role name. If not specified, the default role name, `{database_name}_owner`, will be used.\n",
              demandOption: false,
  },
  'project.branch.database_name': {
              type: "string",
              description: "The database name. If not specified, the default database name, `neondb`, will be used.\n",
              demandOption: false,
  },
  'project.provisioner': {
              type: "string",
              description: "Compute provisioner. `k8s-neonvm` (default) supports Autoscaling; `k8s-pod` is fixed-size compute. Also `docker` and `serverless-platform`.",
              demandOption: false,
  },
  'project.region_id': {
              type: "string",
              description: "The region identifier. Refer to our [Regions](https://neon.com/docs/introduction/regions) documentation for supported regions. Values are specified in this format: `aws-us-east-1`\n",
              demandOption: false,
  },
  'project.default_endpoint_settings.suspend_timeout_seconds': {
              type: "number",
              description: "Scale-to-zero idle timeout, in seconds, before the compute suspends. `0` uses the plan default; `-1` disables scale-to-zero (never suspends). Minimum is plan-dependent (Scale: 60); maximum 604800 (one week). Free cannot change it; Launch can only enable or disable; Scale can set any value.",
              demandOption: false,
  },
  'project.pg_version': {
              type: "number",
              description: "The major Postgres version number. Supported versions are `14`, `15`, `16`, `17`, and `18`. `19` is rolling out and is accepted only in regions where it is enabled; requesting it elsewhere returns an error.",
              demandOption: false,
  },
  'project.store_passwords': {
              type: "boolean",
              description: "Whether or not passwords are stored for roles in the Neon project. Storing passwords facilitates access to Neon features that require authorization.\n",
              demandOption: false,
  },
  'project.history_retention_seconds': {
              type: "number",
              description: "History window (point-in-time restore range) for all branches, in seconds. `0` disables it. Default 1 day (Free: 6 hours). Maximum depends on plan: Free 6 hours (21600), Launch 7 days (604800), Scale 30 days (2592000).\n",
              demandOption: false,
  },
  'project.org_id': {
              type: "string",
              description: "ID of the organization that will own the project. If omitted when using an organization API key, it is inferred from the key.\n",
              demandOption: false,
  },
} as const;

export const projectUpdateRequest = {
  'project.settings.quota.active_time_seconds': {
              type: "number",
              description: "The total amount of wall-clock time allowed to be spent by the project's compute endpoints.\n",
              demandOption: false,
  },
  'project.settings.quota.compute_time_seconds': {
              type: "number",
              description: "The total amount of CPU seconds allowed to be spent by the project's compute endpoints.\n",
              demandOption: false,
  },
  'project.settings.quota.written_data_bytes': {
              type: "number",
              description: "Total amount of data written to all of a project's branches.\n",
              demandOption: false,
  },
  'project.settings.quota.data_transfer_bytes': {
              type: "number",
              description: "Total amount of data transferred from all of a project's branches using the proxy.\n",
              demandOption: false,
  },
  'project.settings.quota.logical_size_bytes': {
              type: "number",
              description: "Limit on the logical size of every project's branch.\n\nIf a branch exceeds its `logical_size_bytes` quota, computes can still be started,\nbut write operations will fail—allowing data to be deleted to free up space.\nComputes on other branches are not affected.\n\nSetting `logical_size_bytes` overrides any lower value set by the `neon.max_cluster_size` Postgres setting.\n",
              demandOption: false,
  },
  'project.settings.allowed_ips.ips': {
              type: "array",
              description: "A list of IP addresses that are allowed to connect to the endpoint.",
              demandOption: false,
  },
  'project.settings.allowed_ips.protected_branches_only': {
              type: "boolean",
              description: "If true, the list will be applied only to protected branches.",
              demandOption: false,
  },
  'project.settings.enable_logical_replication': {
              type: "boolean",
              description: "Sets wal_level=logical for all compute endpoints in this project.\nAll active endpoints will be suspended.\nOnce enabled, logical replication cannot be disabled.\n",
              demandOption: false,
  },
  'project.settings.maintenance_window.weekdays': {
              type: "array",
              description: "A list of weekdays when the maintenance window is active.\nEncoded as ints, where 1 - Monday, and 7 - Sunday.\n",
              demandOption: true,
  },
  'project.settings.maintenance_window.start_time': {
              type: "string",
              description: "Start time of the maintenance window, in the format of \"HH:MM\". Uses UTC.\n",
              demandOption: true,
  },
  'project.settings.maintenance_window.end_time': {
              type: "string",
              description: "End time of the maintenance window, in the format of \"HH:MM\". Uses UTC.\n",
              demandOption: true,
  },
  'project.settings.block_public_connections': {
              type: "boolean",
              description: "When set, connections from the public internet\nare disallowed. This supersedes the AllowedIPs list.\nThis parameter is under active development and its semantics may change in the future.\n",
              demandOption: false,
  },
  'project.settings.block_vpc_connections': {
              type: "boolean",
              description: "When set, connections using VPC endpoints are disallowed.\nThis parameter is under active development and its semantics may change in the future.\n",
              demandOption: false,
  },
  'project.settings.audit_log_level': {
              type: "string",
              description: "Audit logging level, set only on HIPAA-enabled organizations (absent otherwise). Values: `base`, `extended`, `full`; HIPAA defaults to `extended`. Cannot be lowered back to `base` once `extended` or `full`.",
              demandOption: false,
 choices: ["base","extended","full"],
  },
  'project.settings.hipaa': {
              type: "boolean",
              description: "Enables HIPAA compliance mode for the project, including audit logging.",
              demandOption: false,
  },
  'project.settings.preload_libraries.use_defaults': {
              type: "boolean",
              description: "When true, the project's preload libraries include the platform default set in addition to any libraries listed in `enabled_libraries`.",
              demandOption: false,
  },
  'project.settings.preload_libraries.enabled_libraries': {
              type: "array",
              description: "Names of shared preload libraries to enable for the project.",
              demandOption: false,
  },
  'project.name': {
              type: "string",
              description: "The project name",
              demandOption: false,
  },
  'project.default_endpoint_settings.suspend_timeout_seconds': {
              type: "number",
              description: "Scale-to-zero idle timeout, in seconds, before the compute suspends. `0` uses the plan default; `-1` disables scale-to-zero (never suspends). Minimum is plan-dependent (Scale: 60); maximum 604800 (one week). Free cannot change it; Launch can only enable or disable; Scale can set any value.",
              demandOption: false,
  },
  'project.history_retention_seconds': {
              type: "number",
              description: "History window (point-in-time restore range) for all branches, in seconds. `0` disables it. Default 1 day (Free: 6 hours). Maximum depends on plan: Free 6 hours (21600), Launch 7 days (604800), Scale 30 days (2592000).\n",
              demandOption: false,
  },
} as const;

export const branchCreateRequest = {
  'endpoints': {
              type: "array",
              description: "Compute endpoints to create together with the branch. If omitted, the branch is created without any compute endpoint. Endpoints can be added to the branch separately after creation.",
              demandOption: false,
  },
  'branch.parent_id': {
              type: "string",
              description: "The `branch_id` of the parent branch. If omitted or empty, the branch will be created from the project's default branch.\n",
              demandOption: false,
  },
  'branch.name': {
              type: "string",
              description: "The branch name\n",
              demandOption: false,
  },
  'branch.parent_lsn': {
              type: "string",
              description: "A Log Sequence Number (LSN) on the parent branch. The branch will be created with data from this LSN.\n",
              demandOption: false,
  },
  'branch.parent_timestamp': {
              type: "string",
              description: "A timestamp identifying a point in time on the parent branch. The branch will be created with data starting from this point in time. RFC 3339 format.\n",
              demandOption: false,
  },
  'branch.protected': {
              type: "boolean",
              description: "Whether the branch is protected. Protected branches (and their computes) cannot be deleted, archived, or reset, and block deletion of the project. Can be gated by `protected_branches_only` in the IP allowlist. Paid plans only.\n",
              demandOption: false,
  },
  'branch.archived': {
              type: "boolean",
              description: "Whether to create the branch in the archived state. When omitted, the branch is created as a normal (non-archived) branch.\n",
              demandOption: false,
  },
  'branch.init_source': {
              type: "string",
              description: "Source of initialization for the branch. `parent-data` copies schema and data from the parent branch. `parent-schema` copies schema only from the parent branch. `schema-only` creates a new root branch containing schema only, using `parent_id` as the source; optionally, `parent_lsn` or `parent_timestamp` can narrow the source point. `import` initializes the branch from an external import.",
              demandOption: false,
  },
  'branch.expires_at': {
              type: "string",
              description: "The timestamp when the branch is scheduled to expire and be automatically deleted. Must be set by the client following the [RFC 3339, section 5.6](https://tools.ietf.org/html/rfc3339#section-5.6) format with precision up to seconds (such as 2025-06-09T18:02:16Z). Deletion is performed by a background job and may not occur exactly at the specified time.\n\nAccess to this feature is currently limited to participants in the Early Access Program.\n",
              demandOption: false,
  },
} as const;

export const branchCreateRequestEndpointOptions = {
  'type': {
              type: "string",
              description: "Compute endpoint type. `read_write`: the primary read-write endpoint (one per branch). `read_only`: a read replica endpoint (multiple allowed per branch).",
              demandOption: true,
 choices: ["read_only","read_write"],
  },
  'settings.preload_libraries.use_defaults': {
              type: "boolean",
              description: "When true, the project's preload libraries include the platform default set in addition to any libraries listed in `enabled_libraries`.",
              demandOption: false,
  },
  'settings.preload_libraries.enabled_libraries': {
              type: "array",
              description: "Names of shared preload libraries to enable for the project.",
              demandOption: false,
  },
  'provisioner': {
              type: "string",
              description: "Compute provisioner. `k8s-neonvm` (default) supports Autoscaling; `k8s-pod` is fixed-size compute. Also `docker` and `serverless-platform`.",
              demandOption: false,
  },
  'suspend_timeout_seconds': {
              type: "number",
              description: "Scale-to-zero idle timeout, in seconds, before the compute suspends. `0` uses the plan default; `-1` disables scale-to-zero (never suspends). Minimum is plan-dependent (Scale: 60); maximum 604800 (one week). Free cannot change it; Launch can only enable or disable; Scale can set any value.",
              demandOption: false,
  },
} as const;

export const branchUpdateRequest = {
  'branch.name': {
              type: "string",
              description: "New display name for the branch.",
              demandOption: false,
  },
  'branch.protected': {
              type: "boolean",
              description: "Whether the branch is protected. Protected branches (and their computes) cannot be deleted, archived, or reset, and block deletion of the project. Can be gated by `protected_branches_only` in the IP allowlist. Paid plans only.\n",
              demandOption: false,
  },
  'branch.expires_at': {
              type: "string",
              description: "The timestamp when the branch is scheduled to expire and be automatically deleted. Must be set by the client following the [RFC 3339, section 5.6](https://tools.ietf.org/html/rfc3339#section-5.6) format with precision up to seconds (such as 2025-06-09T18:02:16Z). Deletion is performed by a background job and may not occur exactly at the specified time. If this field is set to null, the expiration timestamp is removed.\n\nAccess to this feature is currently limited to participants in the Early Access Program.\n",
              demandOption: false,
  },
} as const;

export const endpointCreateRequest = {
  'endpoint.branch_id': {
              type: "string",
              description: "The ID of the branch the compute endpoint will be associated with\n",
              demandOption: true,
  },
  'endpoint.region_id': {
              type: "string",
              description: "The region where the compute endpoint will be created. Only the project's `region_id` is permitted.\n",
              demandOption: false,
  },
  'endpoint.type': {
              type: "string",
              description: "Compute endpoint type. `read_write`: the primary read-write endpoint (one per branch). `read_only`: a read replica endpoint (multiple allowed per branch).",
              demandOption: true,
 choices: ["read_only","read_write"],
  },
  'endpoint.settings.preload_libraries.use_defaults': {
              type: "boolean",
              description: "When true, the project's preload libraries include the platform default set in addition to any libraries listed in `enabled_libraries`.",
              demandOption: false,
  },
  'endpoint.settings.preload_libraries.enabled_libraries': {
              type: "array",
              description: "Names of shared preload libraries to enable for the project.",
              demandOption: false,
  },
  'endpoint.provisioner': {
              type: "string",
              description: "Compute provisioner. `k8s-neonvm` (default) supports Autoscaling; `k8s-pod` is fixed-size compute. Also `docker` and `serverless-platform`.",
              demandOption: false,
  },
  'endpoint.pooler_enabled': {
              type: "boolean",
              description: "Deprecated. To enable connection pooling, append `-pooler` to the endpoint ID in the connection string.\nSee [How to use connection pooling](https://neon.com/docs/connect/connection-pooling#how-to-use-connection-pooling)\n",
              demandOption: false,
  },
  'endpoint.pooler_mode': {
              type: "string",
              description: "Deprecated. The connection pooler mode. Removal scheduled for June 20, 2026.\n",
              demandOption: false,
 choices: ["transaction"],
  },
  'endpoint.disabled': {
              type: "boolean",
              description: "Whether to restrict connections to the compute endpoint.\nEnabling this option schedules a suspend compute operation.\nA disabled compute endpoint cannot be enabled by a connection or\nconsole action. However, the compute endpoint is periodically\nenabled by check_availability operations.\n",
              demandOption: false,
  },
  'endpoint.passwordless_access': {
              type: "boolean",
              description: "NOT YET IMPLEMENTED. Whether to permit passwordless access to the compute endpoint.\n",
              demandOption: false,
  },
  'endpoint.suspend_timeout_seconds': {
              type: "number",
              description: "Scale-to-zero idle timeout, in seconds, before the compute suspends. `0` uses the plan default; `-1` disables scale-to-zero (never suspends). Minimum is plan-dependent (Scale: 60); maximum 604800 (one week). Free cannot change it; Launch can only enable or disable; Scale can set any value.",
              demandOption: false,
  },
  'endpoint.name': {
              type: "string",
              description: "Optional name of the compute endpoint\n",
              demandOption: false,
  },
} as const;

export const endpointUpdateRequest = {
  'endpoint.branch_id': {
              type: "string",
              description: "Deprecated. The destination branch ID; must not have an existing read-write endpoint.\n",
              demandOption: false,
  },
  'endpoint.provisioner': {
              type: "string",
              description: "Compute provisioner. `k8s-neonvm` (default) supports Autoscaling; `k8s-pod` is fixed-size compute. Also `docker` and `serverless-platform`.",
              demandOption: false,
  },
  'endpoint.settings.preload_libraries.use_defaults': {
              type: "boolean",
              description: "When true, the project's preload libraries include the platform default set in addition to any libraries listed in `enabled_libraries`.",
              demandOption: false,
  },
  'endpoint.settings.preload_libraries.enabled_libraries': {
              type: "array",
              description: "Names of shared preload libraries to enable for the project.",
              demandOption: false,
  },
  'endpoint.pooler_enabled': {
              type: "boolean",
              description: "Deprecated. To enable connection pooling, append `-pooler` to the endpoint ID in the connection string.\nSee [How to use connection pooling](https://neon.com/docs/connect/connection-pooling#how-to-use-connection-pooling)\n",
              demandOption: false,
  },
  'endpoint.pooler_mode': {
              type: "string",
              description: "Deprecated. The connection pooler mode. Removal scheduled for June 20, 2026.\n",
              demandOption: false,
 choices: ["transaction"],
  },
  'endpoint.disabled': {
              type: "boolean",
              description: "Whether to restrict connections to the compute endpoint.\nEnabling this option schedules a suspend compute operation.\nA disabled compute endpoint cannot be enabled by a connection or\nconsole action. However, the compute endpoint is periodically\nenabled by check_availability operations.\n",
              demandOption: false,
  },
  'endpoint.passwordless_access': {
              type: "boolean",
              description: "NOT YET IMPLEMENTED. Whether to permit passwordless access to the compute endpoint.\n",
              demandOption: false,
  },
  'endpoint.suspend_timeout_seconds': {
              type: "number",
              description: "Scale-to-zero idle timeout, in seconds, before the compute suspends. `0` uses the plan default; `-1` disables scale-to-zero (never suspends). Minimum is plan-dependent (Scale: 60); maximum 604800 (one week). Free cannot change it; Launch can only enable or disable; Scale can set any value.",
              demandOption: false,
  },
  'endpoint.name': {
              type: "string",
              description: "Optional name of the compute endpoint\n",
              demandOption: false,
  },
} as const;

export const databaseCreateRequest = {
  'database.name': {
              type: "string",
              description: "Name of the database to create.\n",
              demandOption: true,
  },
  'database.owner_name': {
              type: "string",
              description: "The name of the role that owns the database\n",
              demandOption: true,
  },
} as const;

export const roleCreateRequest = {
  'role.name': {
              type: "string",
              description: "The role name. Cannot exceed 63 bytes in length.\n",
              demandOption: true,
  },
  'role.no_login': {
              type: "boolean",
              description: "Whether to create a role that cannot login.\n",
              demandOption: false,
  },
} as const;

