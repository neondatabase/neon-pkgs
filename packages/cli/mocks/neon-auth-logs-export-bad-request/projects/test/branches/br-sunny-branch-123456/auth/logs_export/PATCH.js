export default function (req, res) {
  res.status(400).send({
    request_id: 'req-logs-export-bad-request',
    code: '',
    message: 'invalid request body',
  });
}
