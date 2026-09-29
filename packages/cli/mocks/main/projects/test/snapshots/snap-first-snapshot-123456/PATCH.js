export default function (req, res) {
  const update = req.body.snapshot ?? {};
  res.status(200).json({
    snapshot: {
      id: 'snap-first-snapshot-123456',
      name: update.name ?? 'nightly',
      source_branch_id: 'br-main-branch-123456',
      created_at: '2021-01-01T00:00:00.000Z',
      // `null` clears the expiration; a string sets it; `undefined` leaves it.
      ...(update.expires_at === null
        ? {}
        : {
            expires_at:
              update.expires_at ?? '2022-01-01T00:00:00.000Z',
          }),
      manual: false,
    },
  });
}
