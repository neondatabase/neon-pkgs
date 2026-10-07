export default function (req, res) {
  res.status(404).send({ message: 'Neon Auth is not enabled for this branch' });
}
