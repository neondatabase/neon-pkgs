export default function (req, res) {
  res.status(400).send({
    code: 'INVALID_SHARED_OAUTH_PROVIDER',
    message: 'This provider requires custom credentials',
  });
}
