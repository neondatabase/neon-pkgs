// Mirrors the backend 404 for a trigger that isn't on the branch, so the CLI's
// message translation (function trigger not visible on branch -> friendly) is exercised.
export default function (req, res) {
  res.status(404).send({ message: 'function trigger not visible on branch' });
}
