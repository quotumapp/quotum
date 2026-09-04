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
	console.error(`Module and table boundary check failed with ${violations.length} violation(s):`);
	for (const violation of violations) {
		console.error(`- ${formatBoundaryViolation(violation)}`);
	}
	process.exitCode = 1;
} else {
	console.log(
		`Module and table boundaries verified across ${sourceFiles.length} TypeScript source files and ${migrationFiles.length} SQL migrations.`,
	);
}
