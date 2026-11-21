export default function (_req, res) {
	res.status(200).send({
		token_id: "cred-parent-123",
		api_token: "parent-branch-api-token",
		s3_secret_access_key: "parent-branch-s3-secret",
	});
}
