export default function (req, res) {
  res.send({
    id: 'apple',
    type: 'standard',
    client_id: req.body.client_id || 'com.example.services',
    apple_team_id: req.body.apple_team_id,
    apple_key_id: req.body.apple_key_id,
  });
}
