// A project-scoped key's refusal that does not name the project.
export default function (_req, res) {
  res.status(404).json({
    code: '',
    message: 'not allowed to perform actions outside the project this key is scoped to',
  });
}
