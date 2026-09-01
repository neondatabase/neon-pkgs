import type { CommonProps } from "./types.js";

type ApiClient = CommonProps["apiClient"];

const customDomainsPath = (projectId: string, branchId: string) =>
	`/projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(
		branchId,
	)}/custom-domains`;

export type CustomDomain = {
	domain: string;
	entity_type: string;
	entity_id: string;
	cname_target: string;
};

export type ListCustomDomainsPage = {
	custom_domains: CustomDomain[];
	next?: string;
};

export const listCustomDomains = async (
	apiClient: ApiClient,
	projectId: string,
	branchId: string,
	{ cursor, limit }: { cursor?: string; limit?: number } = {},
): Promise<ListCustomDomainsPage> => {
	const { data } = await apiClient.request<{
		custom_domains: CustomDomain[];
		pagination?: { next?: string };
	}>({
		path: customDomainsPath(projectId, branchId),
		method: "GET",
		query: { cursor, limit },
		secure: true,
		format: "json",
	});
	return {
		custom_domains: data.custom_domains ?? [],
		next: data.pagination?.next,
	};
};

export const registerCustomDomain = async (
	apiClient: ApiClient,
	projectId: string,
	branchId: string,
	input: { domain: string; entity_type: string; entity_id: string },
): Promise<CustomDomain> => {
	const { data } = await apiClient.request<CustomDomain>({
		path: customDomainsPath(projectId, branchId),
		method: "POST",
		body: input,
		format: "json",
		secure: true,
	});
	return data;
};

export const deleteCustomDomain = async (
	apiClient: ApiClient,
	projectId: string,
	branchId: string,
	domain: string,
): Promise<void> => {
	await apiClient.request({
		path: `${customDomainsPath(projectId, branchId)}/${encodeURIComponent(domain)}`,
		method: "DELETE",
		secure: true,
	});
};
