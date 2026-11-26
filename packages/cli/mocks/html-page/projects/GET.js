// What a web app, rather than the Neon API, answers when --api-host points at it.
export default function (_req, res) {
  res
    .status(200)
    .type('html')
    .send('<!DOCTYPE html><html><body>Neon Console</body></html>');
}
