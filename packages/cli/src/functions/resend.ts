import type { BuiltinTemplate } from "./registry.js";

const SEND_EMAIL_SOURCE = `import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const handler = async (_request: Request): Promise<Response> => {
	const { data, error } = await resend.emails.send({
		from: "onboarding@resend.dev",
		to: "delivered@resend.dev",
		subject: "hello world",
		html: "<strong>it works!</strong>",
	});

	if (error) {
		return Response.json({ error }, { status: 500 });
	}

	return Response.json({ data });
};

export default { fetch: handler };
`;

const SEND_BATCH_SOURCE = `import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const handler = async (_request: Request): Promise<Response> => {
	const { data, error } = await resend.batch.send([
		{
			from: "onboarding@resend.dev",
			to: "delivered@resend.dev",
			subject: "hello world",
			html: "<strong>it works!</strong>",
		},
		{
			from: "onboarding@resend.dev",
			to: "delivered@resend.dev",
			subject: "hello again",
			html: "<strong>second message</strong>",
		},
	]);

	if (error) {
		return Response.json({ error }, { status: 500 });
	}

	return Response.json({ data });
};

export default { fetch: handler };
`;

const GET_EMAIL_SOURCE = `import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const handler = async (request: Request): Promise<Response> => {
	const id = new URL(request.url).searchParams.get("id");
	if (!id) {
		return Response.json({ error: "Pass an email id as ?id=..." }, { status: 400 });
	}

	const { data, error } = await resend.emails.get(id);

	if (error) {
		return Response.json({ error }, { status: 500 });
	}

	return Response.json({ data });
};

export default { fetch: handler };
`;

const CANCEL_EMAIL_SOURCE = `import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const handler = async (request: Request): Promise<Response> => {
	const id = new URL(request.url).searchParams.get("id");
	if (!id) {
		return Response.json({ error: "Pass a scheduled email id as ?id=..." }, { status: 400 });
	}

	const { data, error } = await resend.emails.cancel(id);

	if (error) {
		return Response.json({ error }, { status: 500 });
	}

	return Response.json({ data });
};

export default { fetch: handler };
`;

export const RESEND_TEMPLATE: BuiltinTemplate = {
	template: {
		id: "resend",
		provider: "Resend",
		title: "Send email with Resend",
		description:
			"A ready-to-run email function using the official Resend Node SDK.",
		layout: "separate",
		dependencies: ["resend@6.28.0"],
		environment: [
			{
				name: "RESEND_API_KEY",
				description: "API key from the Resend dashboard.",
			},
		],
		operations: [
			{
				id: "send-email",
				title: "Send an email",
				description: "Send a single transactional email.",
				source: "functions/send-email.ts",
				slug: "sendemail",
				recommended: true,
			},
			{
				id: "send-batch",
				title: "Send a batch of emails",
				description: "Send several emails in one API call.",
				source: "functions/send-batch.ts",
				slug: "sendbatch",
				recommended: true,
			},
			{
				id: "get-email",
				title: "Retrieve an email",
				description: "Look up a previously sent email by id.",
				source: "functions/get-email.ts",
				slug: "getemail",
				recommended: true,
			},
			{
				id: "cancel-email",
				title: "Cancel a scheduled email",
				description: "Cancel a scheduled email by id.",
				source: "functions/cancel-email.ts",
				slug: "cancelemail",
				recommended: false,
			},
		],
	},
	sources: {
		"functions/send-email.ts": SEND_EMAIL_SOURCE,
		"functions/send-batch.ts": SEND_BATCH_SOURCE,
		"functions/get-email.ts": GET_EMAIL_SOURCE,
		"functions/cancel-email.ts": CANCEL_EMAIL_SOURCE,
	},
};
