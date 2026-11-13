export default function (req, res) {
  res.send({
    id: 'discord',
    type: 'standard',
    client_id: req.body.client_id || 'discord-client',
  });
}
