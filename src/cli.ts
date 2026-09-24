import { runQuotumCli } from "./composition/cli/dispatch";

if (import.meta.main) {
	process.exitCode = await runQuotumCli(process.argv.slice(2));
}
