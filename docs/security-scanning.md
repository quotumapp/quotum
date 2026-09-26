# Security scanning

- Document kind: Current behavior
- Sources: [source workflow](../.github/workflows/security.yml), [shared validation](../.github/workflows/validate.yml), [image scans](../.github/workflows/trivy-image.yml), [scanner installer](../ci/security/install-scanner.sh).

Quotum uses three complementary scanners. Biome, TypeScript, module boundaries, coverage and
the billing/tenant/worker tests remain the quality and behavior checks.

| Scanner | Scope | When | Findings policy |
| --- | --- | --- | --- |
| Opengrep | Runtime TypeScript with four repository-owned security rules | Pull requests, merge groups, main, manual runs, weekly | Any finding, invalid rule or scan warning fails the job |
| Trivy filesystem | `bun.lock` including development dependencies, repository secrets, supported configuration files | Pull requests, merge groups, main, manual runs, daily | High/critical findings fail; vulnerabilities without a known fix are deferred |
| Trivy image | Built CI image, both published image architectures, latest stable image | Shared validation, each publication, daily for latest | High/critical package vulnerabilities with known fixes fail |
| CodeQL | JavaScript/TypeScript and GitHub Actions, default query suites | Pull requests, merge groups, main, manual runs, weekly | Findings are uploaded to GitHub code scanning for review |

The [Security workflow](../.github/workflows/security.yml) uses ordinary `pull_request` events,
including fork contributions, with read-only tokens and without repository secrets. GitHub's PR
upload mechanism accepts SARIF with these restricted tokens. All scanner jobs remain read-only
on other events too: they retain SARIF artifacts for a separate publishing job. Only that job,
which never runs for pull requests or executes repository scripts, requests `security-events: write`.
It publishes available reports even when a scanner fails on findings. Image scans use read-only
jobs and retain JSON reports as workflow artifacts.
Schedules use UTC and become active when the workflow reaches the default branch.

Successful CodeQL execution does not mean there are no findings. Configure GitHub's repository
rules to require the desired security checks and code-scanning alert thresholds before treating
them as merge protection. This change defines the workflows; it does not modify repository rules.

## Local checks

The installer supports Linux x86_64 runners and Apple Silicon macOS. It downloads official
Opengrep 1.30.0 and Trivy 0.74.0 assets and verifies committed SHA-256 checksums before execution.
Choose an absolute installation path and add it to `PATH`:

```sh
sh ci/security/install-scanner.sh opengrep /tmp/quotum-scanners
sh ci/security/install-scanner.sh trivy /tmp/quotum-scanners
export PATH="/tmp/quotum-scanners:$PATH"
sh ci/security/test-opengrep.sh
opengrep scan --config ci/security/opengrep.yml --error --strict --disable-version-check src
trivy fs --config ci/security/trivy.yaml .
trivy image --config ci/security/trivy-image.yaml quotum-api:ci
```

Opengrep uses the committed rules only, without downloading a registry ruleset. The rules and
safe/unsafe fixtures are Apache-2.0 like the repository. They cover interpolated or concatenated
Drizzle/Bun raw SQL calls, disabled TLS verification, JavaScript string evaluation, and direct
global `fetch` calls under `src/projections/`. Fixtures include Elysia handlers and permitted
parameterized queries and projection wrappers. The fixtures are never executed; the test runner
copies them into temporary TypeScript files for analysis.

These are narrow syntax policies, not complete taint or authorization analysis: aliased functions,
SQL constructed earlier, custom wrappers and framework-specific flows may need additional rules
or models. CodeQL supplies broader security queries. Neither scanner proves tenant isolation,
idempotency, money arithmetic or concurrent worker correctness.

Trivy downloads public advisory/check databases and scans locally. Repository scans omit
dependencies on disk, generated output and scanner fixtures; dependencies are read from the
committed lockfile. Image scans inspect installed production packages and OS packages. Source
SARIF reports go to GitHub's Security tab even when findings fail the scan step.

## Triage and updates

The first image scan found fixed vulnerabilities in four Debian packages and the Go-based
TypeScript compiler installed through Elysia's optional peer dependency. The Dockerfile upgrades
`gzip`, `libpcre2-8-0`, `libsqlite3-0` and `perl-base` from Debian's configured repositories and
removes the development-only compiler from production dependencies. The build keeps the compiler
for development checks; the runtime uses Bun directly. CI verifies the compiler is absent from
the final image and runs the operator commands and headless Compose smoke test.

The initial ruleset has no blanket baseline or ignored CVEs. Fix a finding, or document a narrowly
scoped false-positive suppression with its reason. Re-run the scanner and safe/unsafe fixtures
when changing a rule. Do not disable a whole scanner to work around one alert.

High/critical fixable vulnerabilities are the initial Trivy gate; lower severities and unfixed
vulnerabilities are outside that gate. To include all known vulnerabilities during an audit:

```sh
trivy fs --config ci/security/trivy.yaml --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
  --ignore-unfixed=false .
```

For scanner upgrades, review the upstream release, update the versions and each platform checksum
in `ci/security/install-scanner.sh`, then run local scans and CI. CodeQL actions are pinned to a
reviewable commit SHA; update all init/analyze/upload references together. Dependency databases
and the default CodeQL bundle continue receiving upstream security updates.

The built amd64 image is scanned before publishing. After publishing, the exact multi-platform
digest is scanned for amd64 and arm64 before creating the GitHub Release. A failure at this stage
leaves the pushed image/tags in GHCR but prevents release creation. The daily scan checks both
architectures of `latest` for newly disclosed vulnerabilities.
