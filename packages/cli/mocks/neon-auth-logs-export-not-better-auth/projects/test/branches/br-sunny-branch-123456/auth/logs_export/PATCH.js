export default function (req, res) {
  res.status(400).send({
    request_id: 'req-logs-export-not-better-auth',
    code: '',
    message:
      'logs export is only supported for Neon Auth (better_auth) integrations',
  });
}
