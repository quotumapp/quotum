/**
 * What a project API credential may do. `read_only` reaches only the `/v1` routes that opt in; it is
 * not a human role bundle and does not follow membership roles.
 */
export const credentialAccessLevels = ["full", "read_only"] as const;
export type CredentialAccess = (typeof credentialAccessLevels)[number];
