// Missing-trigger 404 on the delete path, so the CLI's friendly-not-found
// translation is exercised on a mutation, not just on GET.
export default function (req, res) {
  res.status(404).send({ message: 'function trigger not visible on branch' });
}
