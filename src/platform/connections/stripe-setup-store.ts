import type { PlatformQueryExecutor } from "../persistence/query-executor";
import type { ConnectionCipher, SecretEnvelope } from "./cipher";

export interface StripeSetupRun {
	id: string;
	project_instance_id: string;
	instance_key: string;
	actor: string;
	manifest: unknown;
	fingerprint: string;
	state: Record<string, unknown>;
	secret: SecretEnvelope | null;
	created_at: Date;
}
export interface StripeSetupStep {
	request: unknown;
	result: Record<string, unknown> | null;
	created_at: Date;
}

/** Durable operator work, separate from billing and connection activation receipts. */
export class StripeSetupStore {
	constructor(
		readonly executor: PlatformQueryExecutor,
		readonly cipher: ConnectionCipher,
	) {}
	async forInstance(instanceId: string) {
		const [row] = await this.executor.query<StripeSetupRun>({
			text: `SELECT * FROM platform_stripe_setups WHERE project_instance_id=$1`,
			values: [instanceId],
		});
		return row ?? null;
	}
	async accountClaimed(accountId: string, live: boolean, instanceId: string) {
		const rows = await this.executor.query({
			text: `SELECT id FROM platform_connections WHERE stripe_account_id=$1 AND stripe_livemode=$2 AND project_instance_id<>$3`,
			values: [accountId, live, instanceId],
		});
		return rows.length > 0;
	}
	async prepare(
		id: string,
		instanceId: string,
		instanceKey: string,
		actor: string,
		fingerprint: string,
		manifest: unknown,
	) {
		const rows = await this.executor.query<StripeSetupRun>({
			text: `INSERT INTO platform_stripe_setups(id,project_instance_id,instance_key,actor,fingerprint,manifest) VALUES($1,$2,$3,$4,$5,$6::text::jsonb) ON CONFLICT(project_instance_id) DO NOTHING RETURNING *`,
			values: [id, instanceId, instanceKey, actor, fingerprint, JSON.stringify(manifest)],
		});
		const run =
			rows[0] ??
			(
				await this.executor.query<StripeSetupRun>({
					text: `SELECT * FROM platform_stripe_setups WHERE project_instance_id=$1`,
					values: [instanceId],
				})
			)[0];
		if (!run || run.fingerprint !== fingerprint)
			throw new Error("A different Stripe setup already owns this instance");
		return run;
	}
	async get(id: string) {
		const row = await this.find(id);
		if (!row) throw new Error("Stripe setup was not found");
		return row;
	}
	async find(id: string) {
		const [row] = await this.executor.query<StripeSetupRun>({
			text: `SELECT * FROM platform_stripe_setups WHERE id=$1`,
			values: [id],
		});
		return row ?? null;
	}
	async claim(id: string, token: string) {
		const rows = await this.executor.query({
			text: `UPDATE platform_stripe_setups SET lease_id=$2,lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1 AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING id`,
			values: [id, token],
		});
		return rows.length === 1;
	}
	async renew(id: string, token: string) {
		const rows = await this.executor.query({
			text: `UPDATE platform_stripe_setups SET lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() RETURNING id`,
			values: [id, token],
		});
		if (!rows.length) throw new Error("Stripe setup lease was lost");
	}
	async release(id: string, token: string) {
		await this.executor.query({
			text: `UPDATE platform_stripe_setups SET lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2`,
			values: [id, token],
		});
	}
	async patch(id: string, token: string, state: Record<string, unknown>) {
		const rows = await this.executor.query({
			text: `UPDATE platform_stripe_setups SET state=state || $3::text::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() RETURNING id`,
			values: [id, token, JSON.stringify(state)],
		});
		if (!rows.length) throw new Error("Stripe setup lease was lost");
	}
	async seal(run: StripeSetupRun, token: string, secret: string | null) {
		const envelope =
			secret === null ? null : JSON.stringify(this.cipher.encrypt(secret, this.scope(run)));
		const rows = await this.executor.query({
			text: `UPDATE platform_stripe_setups SET secret=$3::text::jsonb WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() RETURNING id`,
			values: [run.id, token, envelope],
		});
		if (!rows.length) throw new Error("Stripe setup lease was lost");
	}
	open(run: StripeSetupRun) {
		return run.secret ? this.cipher.decrypt(run.secret, this.scope(run)) : null;
	}
	private scope(run: StripeSetupRun) {
		return {
			instanceId: run.project_instance_id,
			connectionId: run.id,
			versionId: run.id,
			purpose: "webhookSecret",
			label: "quotum-stripe-setup-v1",
		};
	}
	async step(id: string, token: string, key: string, request: unknown): Promise<StripeSetupStep> {
		await this.executor.query({
			text: `INSERT INTO platform_stripe_setup_steps(setup_id,key,request) SELECT id,$3,$4::text::jsonb FROM platform_stripe_setups WHERE id=$1 AND lease_id=$2 AND lease_until>clock_timestamp() ON CONFLICT DO NOTHING`,
			values: [id, token, key, JSON.stringify(request)],
		});
		const [row] = await this.executor.query<StripeSetupStep>({
			text: `SELECT request,result,created_at FROM platform_stripe_setup_steps WHERE setup_id=$1 AND key=$2`,
			values: [id, key],
		});
		if (!row) throw new Error("Stripe setup lease was lost");
		return row;
	}
	async finish(id: string, token: string, key: string, result: Record<string, unknown>) {
		const rows = await this.executor.query({
			text: `UPDATE platform_stripe_setup_steps s SET result=$4::text::jsonb FROM platform_stripe_setups r WHERE s.setup_id=r.id AND r.id=$1 AND r.lease_id=$2 AND r.lease_until>clock_timestamp() AND s.key=$3 RETURNING s.key`,
			values: [id, token, key, JSON.stringify(result)],
		});
		if (!rows.length) throw new Error("Stripe setup lease was lost");
	}
	async observe(
		id: string,
		instanceId: string,
		versionId: string,
		nonce: string,
		eventId: string,
		occurred: Date,
	) {
		const rows = await this.executor.query({
			text: `UPDATE platform_stripe_setups SET state=state || jsonb_build_object('deliveryEventId',$5::text,'deliveryVerifiedAt',clock_timestamp()),updated_at=clock_timestamp() WHERE id=$1 AND project_instance_id=$2 AND state->>'draftId'=$3 AND state->>'deliveryNonce'=$4 AND $6::timestamptz >= (state->>'deliveryStartedAt')::timestamptz AND abs(extract(epoch FROM clock_timestamp()-$6::timestamptz))<=300 RETURNING id`,
			values: [id, instanceId, versionId, nonce, eventId, occurred],
		});
		return rows.length === 1;
	}
	async rotate(limit = 100) {
		const rows = await this.executor.query<StripeSetupRun>({
			text: `SELECT * FROM platform_stripe_setups WHERE secret IS NOT NULL AND secret->>'keyId'<>$1 ORDER BY id LIMIT $2`,
			values: [this.cipher.activeKeyId, limit],
		});
		let changed = 0;
		for (const row of rows) {
			const envelope = this.cipher.encrypt(this.open(row) ?? "", this.scope(row));
			const updated = await this.executor.query({
				text: `UPDATE platform_stripe_setups SET secret=$2::text::jsonb WHERE id=$1 AND secret=$3::text::jsonb RETURNING id`,
				values: [row.id, JSON.stringify(envelope), JSON.stringify(row.secret)],
			});
			changed += updated.length;
		}
		return changed;
	}
}
