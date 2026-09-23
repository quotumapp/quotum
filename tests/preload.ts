import { beforeEach, expect } from "bun:test";

// bunfig.toml preloads this for every `bun test` run from the repository root, which covers the
// unit lane and the integration, merchant and end-to-end runners. A test that finishes without a
// single assertion fails: a guard such as `if (response.status === 403) expect(...)` that never
// fires, or a loop over an empty list, would otherwise pass without checking anything.
beforeEach(() => {
	expect.hasAssertions();
});
