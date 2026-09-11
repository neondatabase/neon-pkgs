export default function (_req, res) {
	res.status(200).send({
		token_id: "cred-test-123",
		api_token: "nt_live_credtest1234_secret",
		s3_secret_access_key: "nsk_live_testsecret",
	});
}
