export default function (req, res) {
  res.set('Retry-After', '0');
  res.status(429).send({
    request_id: 'req-logs-export-429',
    code: '',
    message: 'status 429',
  });
}
