import { registerQuotumProcessShutdown } from "../composition/public-runtime";
import { createMerchantTestRuntime } from "./merchant-runtime";

const runtime = await createMerchantTestRuntime();
registerQuotumProcessShutdown(runtime);
export default { hostname: runtime.hostname, port: runtime.port, fetch: runtime.app.fetch };
