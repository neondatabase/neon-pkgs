const stamp = {
  created_at: "2019-01-01T00:00:00.000Z",
  updated_at: "2019-01-01T00:00:00.000Z",
};

const project = (index) => ({
  id: `project-${String(index).padStart(3, "0")}`,
  name: `Project ${index}`,
  org_id: "org-alpha",
  region_id: "aws-us-east-2",
  ...stamp,
});

export default function (req, res) {
  if (req.query.cursor === "page-2") {
    return res.json({
      projects: [project(101), project(102)],
    });
  }

  return res.json({
    projects: Array.from({ length: 100 }, (_, i) => project(i + 1)),
    pagination: { cursor: "page-2" },
  });
}
