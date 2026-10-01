import type { MerchantEmail } from "../platform/email";
import type { PlatformQueryValue } from "../platform/persistence/query-executor";

export interface OtpVerificationRow {
	id: string;
	value: string;
	updatedAt: string;
	expiresAt: string;
}

/** Disposable fixture state, observed around ordinary HTTP requests without auth callbacks. */
export class MerchantOtpFixture {
	private readonly rowsByEmail = new Map<string, string>();
	constructor(
		private readonly ports: {
			messages(): readonly Pick<MerchantEmail, "to" | "kind">[];
			readRows(): Promise<OtpVerificationRow[]>;
			expireRow(id: string): Promise<boolean>;
		},
	) {}

	async track(request: () => Promise<Response>): Promise<Response> {
		const before = new Map((await this.ports.readRows()).map((row) => [row.id, row]));
		const messageCount = this.ports.messages().length;
		const response = await request();
		if (!response.ok) return response;
		const messages = this.ports
			.messages()
			.slice(messageCount)
			.filter((mail) => mail.kind === "otp");
		if (messages.length === 0) return response;
		const changed = (await this.ports.readRows()).filter((row) => {
			const previous = before.get(row.id);
			return (
				!previous ||
				previous.value !== row.value ||
				previous.updatedAt !== row.updatedAt ||
				previous.expiresAt !== row.expiresAt
			);
		});
		if (messages.length !== 1 || changed.length !== 1) {
			this.reset();
			throw new Error("OTP fixture requires exactly one message and changed verification row");
		}
		this.rowsByEmail.set(messages[0].to, changed[0].id);
		return response;
	}

	async expire(email: string): Promise<boolean> {
		const id = this.rowsByEmail.get(email);
		return id === undefined ? false : this.ports.expireRow(id);
	}

	reset() {
		this.rowsByEmail.clear();
	}
}

export function createMerchantOtpFixture(
	database: <Rows extends object[] = Record<string, unknown>[]>(
		strings: TemplateStringsArray,
		...values: PlatformQueryValue[]
	) => Promise<Rows>,
	mailer: { readonly messages: readonly Pick<MerchantEmail, "to" | "kind">[] },
) {
	return new MerchantOtpFixture({
		messages: () => mailer.messages,
		readRows: () => database<OtpVerificationRow[]>`
			SELECT id::text,value,updated_at::text AS "updatedAt",expires_at::text AS "expiresAt"
			FROM platform_auth_verifications`,
		async expireRow(id) {
			const rows = await database`
				UPDATE platform_auth_verifications SET expires_at=now()-interval '1 minute'
				WHERE id=${id} RETURNING id`;
			return rows.length === 1;
		},
	});
}
