import { expect } from 'vitest';

export default function (req, res) {
  expect(req.query.hard_delete).toBe('true');
  res.send({
    branch: {
      id: 'br-harddel-branch-123456',
      name: 'harddel-branch',
      created_at: '2021-01-01T00:00:00.000Z',
    },
  });
}
