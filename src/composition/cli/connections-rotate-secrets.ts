import { SQL } from "bun";
import { loadConnectionCipher } from "../../platform/connections/cipher";
import { rotateConnectionSecrets } from "../../platform/connections/rotation";
import { writeStdout } from "../../shared/cli-output";
import { merchantSql } from "../merchant-persistence";

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
		writeStdout(`Re-encrypted ${count} connection secrets with key ${cipher.activeKeyId}.`);
	} finally {
		await sql.close();
	}
}
