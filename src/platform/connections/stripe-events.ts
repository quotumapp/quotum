import type { MerchantSql } from "../database";
export interface SavedStripeAppEvent {
	event_id: string;
	account_id: string;
	livemode: boolean;
	payload: Record<string, unknown>;
}
export class StripeAppEvents {
	constructor(private sql: MerchantSql) {}
	async accept(event: SavedStripeAppEvent) {
		await this
			.sql`INSERT INTO platform_stripe_app_events(event_id,account_id,livemode,payload) VALUES(${event.event_id},${event.account_id},${event.livemode},${JSON.stringify(event.payload)}::text::jsonb) ON CONFLICT(event_id) DO NOTHING`;
	}
	async pending() {
		return this.sql<
			SavedStripeAppEvent[]
		>`SELECT e.event_id,e.account_id,e.livemode,e.payload FROM platform_stripe_app_events e JOIN platform_connections c ON c.stripe_account_id=e.account_id AND c.stripe_livemode=e.livemode JOIN platform_connection_versions v ON v.id=c.active_version_id AND v.connection_id=c.id WHERE v.settings->>'authMethod'='oauth' AND e.processed_at IS NULL AND e.next_attempt_at<=now() ORDER BY e.next_attempt_at,e.created_at LIMIT 100`;
	}
	async defer(id: string) {
		await this
			.sql`UPDATE platform_stripe_app_events SET next_attempt_at=now()+interval '60 seconds' WHERE event_id=${id} AND processed_at IS NULL`;
	}
	async mapping(account: string, livemode: boolean) {
		const [row] = await this.sql<
			{ id: string; project_instance_id: string; active_version_id: string; enabled: boolean }[]
		>`SELECT c.id,c.project_instance_id,c.active_version_id,c.enabled FROM platform_connections c JOIN platform_connection_versions v ON v.id=c.active_version_id AND v.connection_id=c.id WHERE c.stripe_account_id=${account} AND c.stripe_livemode=${livemode} AND v.settings->>'authMethod'='oauth'`;
		return row ?? null;
	}
	async verified(id: string, versionId: string, occurred: Date) {
		await this
			.sql`UPDATE platform_connection_versions SET event_verified_at=now() WHERE connection_id=${id} AND id=${versionId} AND status='active' AND created_at<=${occurred}`;
	}
	async deauthorize(id: string) {
		await this
			.sql`UPDATE platform_connections SET enabled=false,revision=revision+1,updated_at=now() WHERE id=${id} AND enabled`;
	}
	async processed(id: string) {
		await this.sql`UPDATE platform_stripe_app_events SET processed_at=now() WHERE event_id=${id}`;
	}
}
