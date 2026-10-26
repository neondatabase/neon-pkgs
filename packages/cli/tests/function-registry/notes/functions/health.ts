export default {
	fetch(): Response {
		return Response.json({ health: true });
	},
};
