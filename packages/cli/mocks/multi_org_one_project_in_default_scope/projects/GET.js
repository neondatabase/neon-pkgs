// The API key's default scope holds one project, the org the user is working in holds
// another: an unscoped list returns only the default scope's project.
export default function (req, res) {
  const byOrg = {
    'org-default-scope': ['proj-default-scope'],
    'org-other': ['proj-other-org'],
  };
  const ids = byOrg[req.query.org_id ?? 'org-default-scope'] ?? [];
  return res.json({
    projects: ids.map((id) => ({
      id,
      name: id,
      created_at: '2019-01-01T00:00:00.000Z',
      updated_at: '2019-01-01T00:00:00.000Z',
    })),
  });
}
