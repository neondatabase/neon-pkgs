// Withdrawal itself fails, so the CLI must not claim the key was revoked.
export default function (_req, res) {
	res.status(500).json({ message: "Internal error" });
}
