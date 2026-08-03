// Echoes project_id so the scope check in `api-keys create` sees what it asked for.
// The names below drive the failure branches: a 2xx can still be unusable.
export default function (req, res) {
	const base = {
		name: req.body.key_name,
		created_at: "2026-03-02T00:00:00Z",
		created_by: "u-1",
	};
	switch (req.body.key_name) {
		// Scoped to a different project than requested; withdrawal succeeds.
		case "mismatch":
			return res.json({
				...base,
				id: 401,
				key: "napi_wrong_scope",
				project_id: "some-other-project",
			});
		// Scoped to nothing, though a project was requested; withdrawal fails (500 below).
		case "noscope":
			return res.json({ ...base, id: 500, key: "napi_no_scope" });
		// 2xx with no key at all — a live credential the user could never see.
		case "nokey":
			return res.json({ ...base, id: 401 });
		default:
			return res.json({
				...base,
				id: 303,
				key: "napi_org_secret",
				...(req.body.project_id
					? { project_id: req.body.project_id }
					: {}),
			});
	}
}
