import { expect } from "vitest";

export default function (req, res) {
	expect(req.body).toMatchObject({
		principal_type: "user",
		scopes: ["storage:read", "storage:write"],
		name: "app",
	});

	res.status(201).send({
		token_id: "cred-new-123",
		token_id_short: "crednew12345",
		name: "app",
		api_token: "nt_live_crednew12345_secret",
		s3_secret_access_key: "nsk_live_newsecret",
		scopes: ["storage:read", "storage:write"],
		branch_id: "br-main-branch-123456",
		created_at: "2021-01-01T00:00:00.000Z",
		principal_type: "user",
	});
}
