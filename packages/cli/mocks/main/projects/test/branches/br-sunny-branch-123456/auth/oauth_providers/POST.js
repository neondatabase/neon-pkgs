import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('id');

  res.send({
    id: req.body.id,
    type: req.body.client_id ? 'standard' : 'shared',
    client_id: req.body.client_id || '',
    microsoft_tenant_id: req.body.microsoft_tenant_id,
    apple_team_id: req.body.apple_team_id,
    apple_key_id: req.body.apple_key_id,
  });
}
