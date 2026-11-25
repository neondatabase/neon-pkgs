export default function (req, res) {
  res.set('Retry-After', '0');
  res.status(503).send({
    request_id: 'req-logs-export-503',
    code: '',
    message: 'status 503',
  });
}
