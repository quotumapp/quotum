import {
	createQuotumRuntime,
	loadQuotumRuntimeConfig,
	registerQuotumProcessShutdown,
} from "./composition/public-runtime";

const runtime = createQuotumRuntime(loadQuotumRuntimeConfig());
registerQuotumProcessShutdown(runtime);
await runtime.start();
export default runtime.app;
