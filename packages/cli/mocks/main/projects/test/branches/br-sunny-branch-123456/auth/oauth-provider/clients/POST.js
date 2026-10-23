import { expect } from 'vitest';

export default function (req, res) {
  expect(req.body).toHaveProperty('name');
  expect(req.body).toHaveProperty('type');
  expect(Array.isArray(req.body.redirect_uris)).toBe(true);
  expect(Array.isArray(req.body.resources)).toBe(true);
  res.send({
    client_id: 'client-abc123',
    name: req.body.name,
    type: req.body.type,
    redirect_uris: req.body.redirect_uris,
    resources: req.body.resources,
    skip_consent: req.body.skip_consent ?? false,
    disabled: false,
    created_at: '2026-01-01T00:00:00Z',
    ...(req.body.type === 'confidential' ? { client_secret: 'secret-shown-once' } : {}),
  });
}
