// What Neon answers a project-scoped API key that asks to list projects.
export default function (_req, res) {
  res.status(404).json({
    code: '',
    message:
      'not allowed to perform actions outside the project this key is scoped to; subject_project_id:"test-project-123456"',
  });
}
