const stamp = {
  created_at: "2019-01-01T00:00:00.000Z",
  updated_at: "2019-01-01T00:00:00.000Z",
};

export default function (req, res) {
  if (req.query.org_id === "org-beta") {
    return res.json({
      projects: [
        {
          id: "project-web",
          name: "Web",
          org_id: "org-beta",
          region_id: "aws-us-east-2",
          ...stamp,
        },
        {
          id: "project-worker",
          name: "Worker",
          org_id: "org-beta",
          region_id: "aws-us-east-2",
          ...stamp,
        },
      ],
    });
  }

  return res.json({
    projects: [
      {
        id: "project-api",
        name: "API",
        org_id: "org-alpha",
        region_id: "aws-us-east-2",
        ...stamp,
      },
    ],
  });
}
