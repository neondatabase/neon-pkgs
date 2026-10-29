export default function (req, res) {
  res.send({
    id: 'microsoft',
    type: 'standard',
    client_id: req.body.client_id || 'ms-client',
    microsoft_tenant_id: req.body.microsoft_tenant_id,
  });
}
