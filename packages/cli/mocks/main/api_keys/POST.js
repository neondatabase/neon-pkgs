// Echoes the requested name so a test can assert the request body reached the API.
export default function (req, res) {
	res.json({
		id: 201,
		key: "napi_account_secret",
		name: req.body.key_name,
		created_at: "2026-03-01T00:00:00Z",
		created_by: "u-1",
	});
}
