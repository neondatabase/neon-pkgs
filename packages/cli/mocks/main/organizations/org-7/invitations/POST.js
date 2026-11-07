// One invitation per requested email, so the test sees every address the CLI sent.
export default function (req, res) {
	res.json({
		invitations: req.body.invitations.map((invite, index) => ({
			id: `i-${index + 10}`,
			email: invite.email,
			org_id: "org-7",
			invited_by: "u-1",
			invited_at: "2026-01-05T00:00:00Z",
			role: invite.role,
		})),
	});
}
