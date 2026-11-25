export default function (req, res) {
  res.status(404).send({
    request_id: 'req-logs-export-unavailable',
    code: '',
    message: 'not found',
  });
}
