export default {
	fetch(): Response {
		return Response.json({ cancel: true });
	},
};
