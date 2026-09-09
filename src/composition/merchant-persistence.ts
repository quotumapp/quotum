import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { MerchantSql } from "../platform/database";
import * as authSchema from "../platform/persistence/auth-schema";
import type { PlatformQueryValue } from "../platform/persistence/query-executor";
import {
	activateProjectProduction,
	BunPlatformQueryExecutor,
	BunProjectInstanceStore,
} from "./project-instance-persistence";

/** Every instance operation uses the same connection/transaction as merchant persistence. */
export function merchantSql(client: SQL): MerchantSql {
	const executor = new BunPlatformQueryExecutor({
		unsafe: async <Row extends object>(text: string, values?: readonly PlatformQueryValue[]) =>
			(await client.unsafe(text, values?.map(parameter))) as Row[],
	});
	const instances = new BunProjectInstanceStore(executor);
	const query = async <Rows extends object[] = Record<string, unknown>[]>(
		strings: TemplateStringsArray,
		...values: PlatformQueryValue[]
	): Promise<Rows> => (await client(strings, ...values.map(parameter))) as unknown as Rows;
	return Object.assign(query, {
		begin: async <Result>(work: (transaction: MerchantSql) => Promise<Result>): Promise<Result> =>
			(await client.begin((tx) => work(merchantSql(tx)))) as Result,
		instances: {
			forProject: (id: string) => instances.forProject(id),
			create: instances.create.bind(instances),
			activateProduction: (instanceId: string, organizationId: string, catalogRevisionId: string) =>
				activateProjectProduction(client, instanceId, organizationId, catalogRevisionId),
		},
	});
}

export function merchantAuthDatabase(client: SQL) {
	return drizzleAdapter(drizzle({ client, schema: authSchema }), {
		provider: "pg",
		schema: authSchema,
		transaction: true,
	});
}

function parameter(value: PlatformQueryValue) {
	return value instanceof Date ? value.toISOString() : value;
}
