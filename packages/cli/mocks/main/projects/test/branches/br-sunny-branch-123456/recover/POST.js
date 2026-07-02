export default function (req, res) {
  res.send({
    branch: {
      id: 'br-sunny-branch-123456',
      name: 'sunny-branch',
      current_state: 'ready',
      created_at: '2021-01-01T00:00:00.000Z',
    },
  });
}
