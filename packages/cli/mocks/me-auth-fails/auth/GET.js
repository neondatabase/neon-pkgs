export default function (_req, res) {
  res.status(500).json({ code: '', message: 'auth lookup failed' });
}
