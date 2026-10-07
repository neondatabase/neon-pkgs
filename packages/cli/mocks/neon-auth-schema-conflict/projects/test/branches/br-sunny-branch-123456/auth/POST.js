export default function (req, res) {
  res.status(409).send({
    request_id: 'req-schema-conflict',
    code: '',
    message:
      'The `neon_auth` schema already exists and cannot be automatically provisioned. Please drop the existing `neon_auth` schema before provisioning Neon Auth.',
  });
}
