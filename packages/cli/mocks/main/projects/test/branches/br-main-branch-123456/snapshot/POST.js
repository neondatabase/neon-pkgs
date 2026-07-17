import { expect } from 'vitest';

export default function (req, res) {
  // Point-in-time params are mutually exclusive and passed as query params.
  expect(req.query.lsn && req.query.timestamp).toBeFalsy();

  res.status(200).json({
    snapshot: {
      id: 'snap-new-snapshot-123456',
      name: req.query.name ?? 'snap-new-snapshot-123456',
      source_branch_id: 'br-main-branch-123456',
      created_at: '2021-01-01T00:00:00.000Z',
      ...(req.query.lsn ? { lsn: req.query.lsn } : {}),
      ...(req.query.timestamp ? { timestamp: req.query.timestamp } : {}),
      ...(req.query.expires_at ? { expires_at: req.query.expires_at } : {}),
      manual: true,
    },
    operations: [
      {
        id: 'op-create-snapshot-1',
        action: 'create_snapshot',
        status: 'running',
        created_at: '2021-01-01T00:00:00.000Z',
      },
    ],
  });
}
