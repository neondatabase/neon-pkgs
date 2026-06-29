// Runtime enum-like constants for Neon API string unions.
//
// `@neondatabase/api-client` generated TypeScript `enum`s (real runtime objects)
// for fields like the compute endpoint type. `@neon/sdk` instead models these as
// plain string-literal union *types*, which have no runtime value — so code that
// read `EndpointType.ReadWrite` or `Object.values(EndpointType)` no longer works.
//
// These `as const` objects restore that runtime surface, and each is paired with
// a same-named type whose union is identical to the corresponding `@neon/sdk`
// type, so values stay assignable in both directions.

export const EndpointType = {
  ReadOnly: 'read_only',
  ReadWrite: 'read_write',
} as const;
export type EndpointType = (typeof EndpointType)[keyof typeof EndpointType];

export const NeonAuthOauthProviderId = {
  Google: 'google',
  Github: 'github',
  Microsoft: 'microsoft',
  Vercel: 'vercel',
} as const;
export type NeonAuthOauthProviderId =
  (typeof NeonAuthOauthProviderId)[keyof typeof NeonAuthOauthProviderId];

export const NeonAuthOauthProviderType = {
  Standard: 'standard',
  Shared: 'shared',
} as const;
export type NeonAuthOauthProviderType =
  (typeof NeonAuthOauthProviderType)[keyof typeof NeonAuthOauthProviderType];

export const NeonAuthSupportedAuthProvider = {
  Mock: 'mock',
  Stack: 'stack',
  BetterAuth: 'better_auth',
} as const;
export type NeonAuthSupportedAuthProvider =
  (typeof NeonAuthSupportedAuthProvider)[keyof typeof NeonAuthSupportedAuthProvider];

export const NeonAuthEmailVerificationMethod = {
  Link: 'link',
  Otp: 'otp',
} as const;
export type NeonAuthEmailVerificationMethod =
  (typeof NeonAuthEmailVerificationMethod)[keyof typeof NeonAuthEmailVerificationMethod];
