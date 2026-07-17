export default function (_req, res) {
  res.status(200).json({
    operations: [
      {
        id: 'op-finalize-restore-1',
        action: 'finalize_restore',
        status: 'running',
        created_at: '2021-03-01T00:00:00.000Z',
      },
    ],
  });
}
