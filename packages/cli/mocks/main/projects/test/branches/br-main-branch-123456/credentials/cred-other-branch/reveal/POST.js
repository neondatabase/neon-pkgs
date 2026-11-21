export default function (_req, res) {
	res.status(200).send({
		token_id: "cred-other-branch",
		api_token: "other-branch-api-token",
		s3_secret_access_key: "other-branch-s3-secret",
	});
}
