import { expect } from 'vitest';

export default function (req, res) {
  expect(Object.keys(req.body).length).toBeGreaterThan(0);
  res.send({
    client_id: 'client-abc123',
    name: req.body.name ?? 'My MCP client',
    type: 'confidential',
    redirect_uris: req.body.redirect_uris ?? ['https://app.example.com/callback'],
    resources: req.body.resources ?? ['https://api.example.com'],
    skip_consent: req.body.skip_consent ?? false,
    disabled: req.body.disabled ?? false,
    created_at: '2026-01-01T00:00:00Z',
  });
}
