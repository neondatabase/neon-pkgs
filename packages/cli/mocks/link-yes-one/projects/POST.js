export default function (req, res) {
  res.json({
    project: {
      id: "new-project-123456",
      name: req.body.project.name,
      region_id: req.body.project.region_id,
      org_id: req.body.project.org_id,
      created_at: "2022-01-01T00:00:00.000Z",
    },
    branch: {
      id: "br-created-branch-123456",
      name: "main",
      created_at: "2022-01-01T00:00:00.000Z",
    },
    connection_uris: [
      { connection_uri: "postgres://localhost:5432/test_project" },
    ],
  });
}
