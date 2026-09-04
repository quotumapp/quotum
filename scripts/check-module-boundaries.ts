import {
	analyzeModuleBoundaries,
	formatBoundaryViolation,
	readBoundaryAnalysisOptions,
	readBoundarySourceFiles,
} from "./lib/module-boundaries";

const root = process.cwd();
const [files, options] = await Promise.all([
	readBoundarySourceFiles(root),
	readBoundaryAnalysisOptions(root),
]);
const violations = await analyzeModuleBoundaries(files, options);

if (violations.length > 0) {
	console.error(`Module boundary check failed with ${violations.length} violation(s):`);
	for (const violation of violations) {
		console.error(`- ${formatBoundaryViolation(violation)}`);
	}
	process.exitCode = 1;
} else {
	console.log(`Module boundaries verified across ${files.length} TypeScript source files.`);
}
