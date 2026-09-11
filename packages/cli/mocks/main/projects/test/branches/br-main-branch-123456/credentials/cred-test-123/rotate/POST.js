export default function (_req, res) {
	res.status(200).send({
		token_id: "cred-test-123",
		token_id_short: "credtest1234",
		name: "Default object storage credential",
		api_token: "nt_live_credtest1234_rotated",
		s3_secret_access_key: "nsk_live_rotatedsecret",
		scopes: ["storage:read", "storage:write"],
		branch_id: "br-main-branch-123456",
		principal_type: "user",
		created_at: "2021-01-01T00:00:00.000Z",
	});
}
