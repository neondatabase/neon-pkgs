export default {
	fetch(): Response {
		return Response.json({ ingested: true });
	},
};
