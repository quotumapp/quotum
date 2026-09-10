export const concurrentIndexPattern = /CREATE\s+INDEX\s+CONCURRENTLY/i;
const noTransactionMarker = /^\s*--\s*migrate:\s*no-transaction/im;

export type MigrationSource = (filename: string) => Promise<string | null>;

export function calculateMigrationChecksum(content: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(content);
	return hasher.digest("hex");
}

export async function findMigrationIntegrityProblems(
	applied: ReadonlyMap<string, string>,
	readMigration: MigrationSource,
): Promise<string[]> {
	const problems: string[] = [];
	for (const [id, storedChecksum] of applied) {
		const filename = `${id}.sql`;
		const content = await readMigration(filename);
		if (content === null) {
			problems.push(`${filename} - FILE NOT FOUND`);
			continue;
		}

		const currentChecksum = calculateMigrationChecksum(content);
		if (storedChecksum !== currentChecksum) {
			problems.push(`${filename} - CHECKSUM MISMATCH`);
		}
	}
	return problems;
}

export async function verifyAppliedMigrations(
	applied: ReadonlyMap<string, string>,
	readMigration: MigrationSource,
	reportProblem: (line: string) => void = console.error,
): Promise<void> {
	const problems = await findMigrationIntegrityProblems(applied, readMigration);
	if (problems.length === 0) {
		return;
	}
	for (const problem of problems) {
		reportProblem(problem);
	}
	throw new Error("Migration integrity check failed");
}

export function shouldRunMigrationInTransaction(content: string): boolean {
	return !concurrentIndexPattern.test(content) && !noTransactionMarker.test(content);
}
