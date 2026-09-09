import { SQL } from "bun";
import { merchantSql } from "../src/composition/merchant-persistence";
import { loadConnectionCipher } from "../src/platform/connections/cipher";
import { rotateConnectionSecrets } from "../src/platform/connections/rotation";

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
	console.info(`Re-encrypted ${count} connection secrets with key ${cipher.activeKeyId}.`);
} finally {
	await sql.close();
}
