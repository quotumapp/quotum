import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { DomainEventDeliveryRepository } from "../../db/repository/domain-events";
import type { TransactionalQueryExecutor } from "../../db/repository/types";
import * as billingSchema from "../../db/schema";
import { loadConnectionCipher } from "../../platform/connections/cipher";
import { rotateConnectionSecrets } from "../../platform/connections/rotation";
import { writeStderr, writeStdout } from "../../shared/cli-output";
import { merchantSql } from "../merchant-persistence";
import { createWebhookSecretSealer } from "../webhook-secrets";

if (import.meta.main) {
	await rotateSecrets();
}

async function rotateSecrets(): Promise<void> {
	const cipher = loadConnectionCipher();
	const uri = process.env.POSTGRES_URI;
	if (!uri) throw new Error("POSTGRES_URI is required");
	const sql = new SQL(uri, { max: 1 });
	try {
		let count = 0;
		for (;;) {
			const changed = await rotateConnectionSecrets(merchantSql(sql), cipher);
			count += changed;
			if (!changed) break;
		}
		// Webhook signing secrets are sealed with the same keys, in a billing table.
		const webhooks = new DomainEventDeliveryRepository(
			drizzle({ client: sql, schema: billingSchema }) as unknown as TransactionalQueryExecutor,
		);
		const sealer = createWebhookSecretSealer(cipher);
		let endpoints = 0;
		let remaining = 0;
		// A batch skips endpoints another transaction holds, so an empty batch is not proof of
		// completion: check what is left, and give a short-lived lock a few chances to clear.
		for (let pass = 0; pass < 5; pass += 1) {
			for (;;) {
				const changed = await webhooks.resealEndpointSecrets(sealer);
				endpoints += changed;
				if (!changed) break;
			}
			remaining = await webhooks.countEndpointSecretsSealedWithOtherKeys(cipher.activeKeyId);
			if (remaining === 0) break;
			await Bun.sleep(1000);
		}
		writeStdout(`Re-encrypted ${count} connection secrets with key ${cipher.activeKeyId}.`);
		writeStdout(
			`Re-encrypted the signing secrets of ${endpoints} webhook endpoints with key ${cipher.activeKeyId}.`,
		);
		if (remaining > 0) {
			writeStderr(
				`${remaining} webhook endpoints still use another key because they were locked; run the command again before retiring the previous key.`,
			);
			process.exitCode = 1;
		}
	} finally {
		await sql.close();
	}
}
