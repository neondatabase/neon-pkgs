import { expect } from 'vitest';

export default function (req, res) {
  if (req.body.mcp) {
    expect(typeof req.body.mcp.resource).toBe('string');
  }
  res.send({
    enabled: req.body.enabled ?? true,
    login_page: req.body.login_page ?? 'https://app.example.com/login',
    consent_page: req.body.consent_page ?? 'https://app.example.com/consent',
    mcp: req.body.mcp ?? {
      resource: 'https://stored.example.com/mcp',
      dynamic_registration: true,
      client_id_metadata_documents: false,
    },
    resources: req.body.resources ?? [{ identifier: 'https://api.example.com' }],
  });
}
