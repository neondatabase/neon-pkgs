export default function (req, res) {
  res.status(200).json({
    branch: {
      id: 'br-restored-branch-123456',
      name: req.body?.name ?? 'restored-from-snap-first-snapshot-123456',
      source_branch_id: 'br-main-branch-123456',
      parent_id: req.body?.target_branch_id ?? 'br-main-branch-123456',
      created_at: '2021-03-01T00:00:00.000Z',
      current_state: 'ready',
    },
    endpoints: [],
    operations: [
      {
        id: 'op-restore-snapshot-1',
        action: 'restore_snapshot',
        status: 'running',
        created_at: '2021-03-01T00:00:00.000Z',
      },
    ],
  });
}
