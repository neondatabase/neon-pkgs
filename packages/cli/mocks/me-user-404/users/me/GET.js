export default function (_req, res) {
  res.status(404).json({ code: '', message: 'user not found' });
}
