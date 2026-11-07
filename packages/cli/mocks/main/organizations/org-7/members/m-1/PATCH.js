// Echoes the requested role so the test sees what the CLI sent.
export default function (req, res) {
	res.json({
		id: "m-1",
		user_id: "u-1",
		org_id: "org-7",
		role: req.body.role,
		joined_at: "2026-01-02T00:00:00Z",
	});
}
