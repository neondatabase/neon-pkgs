import type { BetterFetchOption } from "@better-fetch/fetch";
import type { BetterAuthClientPlugin } from "better-auth/client";
import z from "zod";

const ANONYMOUS_TOKEN_ENDPOINT = "/token/anonymous";

export const anonymousTokenResponseSchema = z.object({
	token: z.string(),
	expires_at: z.number(),
});

type AnonymousTokenResponseData = z.infer<typeof anonymousTokenResponseSchema>;

export const anonymousTokenClient = () => {
	return {
		id: "anonymous-token",
		pathMethods: {
			[ANONYMOUS_TOKEN_ENDPOINT]: "GET",
		},
		getActions: ($fetch) => {
			return {
				getAnonymousToken: async (fetchOptions?: BetterFetchOption) => {
					const response = await $fetch<AnonymousTokenResponseData>(
						ANONYMOUS_TOKEN_ENDPOINT,
						{
							method: "GET",
							...fetchOptions,
						},
					);
					return response;
				},
			};
		},
	} satisfies BetterAuthClientPlugin;
};
