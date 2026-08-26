import * as api from "./api.js";
import * as apiKeys from "./api_keys.js";
import * as auth from "./auth.js";
import * as bootstrap from "./bootstrap.js";
import * as branches from "./branches.js";
import * as bucket from "./bucket.js";
import * as checkout from "./checkout.js";
import * as claim from "./claim.js";
import * as config from "./config.js";
import * as cs from "./connection_string.js";
import * as dataApi from "./data_api.js";
import * as databases from "./databases.js";
import * as deploy from "./deploy.js";
import * as dev from "./dev.js";
import * as diff from "./diff.js";
import * as env from "./env.js";
import * as functions from "./functions.js";
import * as init from "./init.js";
import * as inspect from "./inspect.js";
import * as ipAllow from "./ip_allow.js";
import * as link from "./link.js";
import * as logs from "./logs.js";
import * as mcp from "./mcp.js";
import * as neonAuth from "./neon_auth.js";
import * as open from "./open.js";
import * as operations from "./operations.js";
import * as orgs from "./orgs.js";
import * as plugins from "./plugins.js";
import * as profile from "./profile.js";
import * as projects from "./projects.js";
import * as psql from "./psql.js";
import * as roles from "./roles.js";
import * as setContext from "./set_context.js";
import * as skills from "./skills.js";
import * as snapshots from "./snapshots.js";
import * as status from "./status.js";
import * as users from "./user.js";
import * as vpcEndpoints from "./vpc_endpoints.js";

export default [
	auth,
	profile,
	apiKeys,
	api,
	users,
	orgs,
	projects,
	ipAllow,
	vpcEndpoints,
	neonAuth,
	branches,
	databases,
	roles,
	operations,
	logs,
	snapshots,
	inspect,
	cs,
	psql,
	setContext,
	checkout,
	link,
	open,
	claim,
	init,
	mcp,
	plugins,
	skills,
	dataApi,
	functions,
	dev,
	diff,
	config,
	status,
	deploy,
	env,
	bucket,
	bootstrap,
];
