// Echoes project_id so the scope check in `api-keys create` sees what it asked for.
export default function (req, res) {
	res.json({
		id: 303,
		key: "napi_org_secret",
		name: req.body.key_name,
		created_at: "2026-03-02T00:00:00Z",
		created_by: "u-1",
		...(req.body.project_id ? { project_id: req.body.project_id } : {}),
	});
}
