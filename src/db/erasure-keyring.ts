import type { SQL } from "bun";
import { type ErasureDigest, type ErasureKeyring, erasureDigests } from "../shared/erasure-digest";

/**
 * The process's erasure keyring. Repositories are built with no arguments in many places and read
 * the one process database, so the keyring is process-level too: composition sets it once from the
 * environment before any request or worker runs. With no keyring there are no digests, and the
 * creation paths run their original statements unchanged.
 */
let configured: ErasureKeyring | null = null;

export function configureErasureKeyring(keyring: ErasureKeyring | null): void {
	configured = keyring;
}

export function configuredErasureKeyring(): ErasureKeyring | null {
	return configured;
}

/** The digests that would match one id's live tombstones, or none without a keyring. */
export function tombstoneDigests(projectId: string, billingAccountId: string): ErasureDigest[] {
	return configured === null ? [] : erasureDigests(configured, projectId, billingAccountId);
}

/**
 * Fails startup when a live tombstone was written under a key this process does not hold, because
 * the creation guard could not match it and would let the erased id come back without a sound.
 * An unreachable database is not a mismatch: the process starts degraded and reports it through
 * its health snapshot, as it does without this check.
 */
export async function assertErasureKeyringCoversTombstones(
	queryClient: SQL,
	keyring: ErasureKeyring | null,
): Promise<void> {
	let rows: { key_id: string }[];
	try {
		rows = await queryClient`
			SELECT DISTINCT key_id FROM customer_erasure_tombstones WHERE expires_at > now()
		`;
	} catch {
		return;
	}
	const held = new Set(
		keyring === null
			? []
			: [keyring.current.id, ...(keyring.previous ? [keyring.previous.id] : [])],
	);
	const missing = rows.map((row) => row.key_id).filter((keyId) => !held.has(keyId));
	if (missing.length > 0) {
		throw new Error(
			`Live erasure tombstones were written under key ${missing.join(", ")}; configure it as BILLING_ERASURE_KEY_ID or BILLING_ERASURE_PREVIOUS_KEY_ID until they expire`,
		);
	}
}
