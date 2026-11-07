export default function (req, res) {
	res.json({ spending_limit_cents: req.body.spending_limit_cents });
}
