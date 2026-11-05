export default function (_req, res) {
  res.status(200).type("application/json").send('{"role":{"password":ep_SECRET_SENTINEL}}');
}
