export default function (_req, res) {
	res.status(404).send({ message: "credential not found" });
}
