export default function (req, res) {
  res.send({
    branch: {
      id: 'br-gone-branch-123456',
      name: 'gone-branch',
      current_state: 'ready',
      created_at: '2021-01-01T00:00:00.000Z',
    },
  });
}
