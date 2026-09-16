import { writeStderr, writeStdout } from "../src/shared/cli-output";
import {
	analyzeRepositoryBoundaries,
	formatBoundaryViolation,
	readBoundaryAnalysisOptions,
	readBoundaryMigrationFiles,
	readBoundarySourceFiles,
} from "./lib/module-boundaries";

const root = process.cwd();
const [sourceFiles, migrationFiles, options] = await Promise.all([
	readBoundarySourceFiles(root),
	readBoundaryMigrationFiles(root),
	readBoundaryAnalysisOptions(root),
]);
const violations = await analyzeRepositoryBoundaries(sourceFiles, migrationFiles, options);

if (violations.length > 0) {
	writeStderr(`Module and table boundary check failed with ${violations.length} violation(s):`);
	for (const violation of violations) {
		writeStderr(`- ${formatBoundaryViolation(violation)}`);
	}
	process.exitCode = 1;
} else {
	writeStdout(
		`Module and table boundaries verified across ${sourceFiles.length} TypeScript source files and ${migrationFiles.length} SQL migrations.`,
	);
}
