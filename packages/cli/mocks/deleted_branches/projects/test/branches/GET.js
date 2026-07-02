import { expect } from 'vitest';

const activeBranch = {
  id: 'br-main-branch-123456',
  name: 'main',
  default: true,
  current_state: 'ready',
  created_at: '2021-01-01T00:00:00.000Z',
  updated_at: '2021-01-01T00:00:00.000Z',
};

const deletedBranch = {
  id: 'br-gone-branch-123456',
  name: 'gone-branch',
  current_state: 'ready',
  created_at: '2021-01-01T00:00:00.000Z',
  updated_at: '2021-01-01T00:00:00.000Z',
  recovery: {
    deleted_at: '2026-06-30T00:00:00.000Z',
    recoverable_until: '2026-07-07T00:00:00.000Z',
    deletion_method: 'user',
  },
};

export default function (req, res) {
  const includeDeleted = req.query.include_deleted === 'true';
  if (!includeDeleted) {
    expect(req.query.include_deleted).toBe('false');
  }
  res.send({
    annotations: {},
    branches: includeDeleted
      ? [activeBranch, deletedBranch]
      : [activeBranch],
  });
}
