export default function (_req, res) {
  res.status(202).json({
    operations: [
      {
        id: 'op-delete-snapshot-1',
        action: 'delete_snapshot',
        status: 'running',
        created_at: '2021-01-01T00:00:00.000Z',
      },
    ],
  });
}
