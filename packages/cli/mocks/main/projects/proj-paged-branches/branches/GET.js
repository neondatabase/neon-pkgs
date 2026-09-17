const stamp = {
  created_at: "2021-01-01T00:00:00.000Z",
  updated_at: "2021-01-01T00:00:00.000Z",
  current_state: "ready",
};

export default function (req, res) {
  if (req.query.cursor === "page-2") {
    return res.json({
      annotations: {},
      branches: [
        {
          id: "br-page-two-123456",
          name: "page-two",
          ...stamp,
        },
      ],
    });
  }

  return res.json({
    annotations: {},
    branches: [
      {
        id: "br-page-one-123456",
        name: "page-one",
        default: true,
        ...stamp,
      },
    ],
    pagination: { next: "page-2" },
  });
}
