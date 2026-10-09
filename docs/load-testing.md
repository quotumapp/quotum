# Load testing

- Document kind: Current behavior
- Sources: [load lane](../scripts/test-load.ts).

`bun run test:load` boots the real service and drives metering over HTTP. The default scenarios use
a closed-loop client; `users` uses a fixed arrival rate. It creates a disposable Postgres container
only when neither `--postgres-uri` nor `POSTGRES_URI` is set. An environment value, including one
loaded by Bun, selects an existing database; `--postgres-uri` overrides it. **The selected database
is migrated, bootstrapped and its billing tables are reset. Use only a disposable database.** A
reused target keeps its earlier bootstrap and issues no fresh credential; add `--recreate-schema`
to drop and recreate its `public` schema first. `--docker` explicitly selects a fresh disposable
container, overriding an environment URI; when combined with `--postgres-uri`, the last selector wins.

The lane's own container keeps its data on a 512 MB tmpfs. A default run of about three and a half
minutes at up to 128 concurrent requests stopped with `Database operation failed`, and the same
sequence completed against a Postgres with an 8 GB data directory. For longer runs start your own
disposable Postgres with a larger data directory and `pg_stat_statements` in
`shared_preload_libraries` (the lane reports statements per request from it), then pass
`--postgres-uri` with `--recreate-schema`. A reused database has no container to sample, so its
Postgres CPU is reported as unavailable.

The lane publishes a metered catalog and grants balances to one hot account and, by default,
1,000 spread accounts. Scenarios are `hot` (one account, one feature), `spread` (round-robin),
`reserve` (reserve then confirm), `check`, and `workers-off` (hot and spread with worker polling
intervals extended to one hour). `users` and `windows` run only when listed. The last scenario keeps polling idle during short runs; it does
not permanently disable workers. Keep `workers-off` last in a custom scenario list because later
scenarios do not restore the normal polling intervals.

## Short control windows

Use `windows` to measure what a short reset costs. It gives every spread account a usage limit that
resets every `--window-cadence` (default `hour`), written straight to the database, then sends each
account one consume while its window does not exist yet and one more once it does. The first pass
is what every active account pays once per window; the report adds the window rows created and their
size on disk with indexes. Projections are drained before each pass, up to `--drain-seconds`.

```sh
bun run test:load --docker --scenarios spread,windows --window-cadence hour \
  --accounts 3000 --concurrency 32 --drain-seconds 180 --out /tmp/quotum-windows.json
```

## One merchant with many active users

Use `users` to test one merchant project with independent billing accounts, each sending exactly
one scheduled `consume` per second. User arrivals are evenly staggered across the second and do
not wait for earlier responses. `--users` specifies successive active-user counts; enough accounts
are seeded automatically. `--concurrency` does not control this scenario.

```sh
BUN_CONFIG_MAX_HTTP_REQUESTS=4096 bun run test:load --docker \
  --scenarios users --users 100,1000,2000,5000,10000 \
  --duration 30 --warmup 2 --max-p99-ms 50 --out /tmp/quotum-users.json
```

This tests 100 through 10,000 requested consumes/second. Bun otherwise queues fetches above its
[default 256 simultaneous-request limit](https://bun.sh/docs/runtime/environment-variables); set
`BUN_CONFIG_MAX_HTTP_REQUESTS` above the harness's `--max-in-flight` limit (default 2000).
The harness counts arrivals it cannot send at that limit
as capacity drops. Arrivals more than 100 ms late are counted as generator drops, without a catch-up
burst. Either means the requested workload was not delivered. Fetch attempts time out after
`--request-timeout-ms` (default 5000); timeout does not imply that the server rolled back.

For `users`, RPS means successful authorizations completed **during the scheduled arrival window**.
Responses completed while draining are reported separately through the total accepted count and
request drain time; they do not inflate that RPS. JSON also reports scheduled/sent/accepted counts,
in-flight requests at the end of the window, dispatch lag, and latency measured from scheduled
arrival as well as actual dispatch. Every successful response is reconciled to a durable idempotency
claim and a matching usage event for the correct account, quantity and wallet charge. Committed
operations with lost responses can exceed the successful-response count. This check is a snapshot
after the drain, not proof that timed-out server work has stopped.

The warmup issues checks rather than consumes. Seed-time projection jobs are cleared before the
first measurement. Each level records projection backlog before load, after request drain, and
after a bounded `--drain-seconds` wait (default 10). The API process is restarted and remaining
fixture projection jobs cleared between levels so overload does not carry queued requests into the
next level. These are independent load levels, not a continuous ramp or a durability/failover test. Metering rate
limits are raised for the fixture; production admission limits are not measured.

Missing arrivals, non-allowed responses, reconciliation failures and leftover projection backlog
fail the lane, as do supplied `--min-rps`/`--max-p99-ms` thresholds. Results and gate failures are
written to `--out` **before** a failing exit, so overload evidence is retained. Database connection
strings are redacted in reports. A short local run validates behavior under load; use longer runs
and a separate generator to establish deployment capacity and steady-state worker freshness.

## Metrics and other options

Results include client latency percentiles, scenario iterations and ledger calls per second,
Postgres transactions, WAL bytes, dead tuples, sampled lock waits, projection jobs created,
delivered and left in backlog, and sampled service/container CPU. A successful reserve iteration
makes two HTTP calls; its client latency covers reserve plus confirm, while server percentiles
use the confirm operation's histogram. Server percentiles are histogram bucket upper bounds.
Statement counts and database time per request are aggregate ratios from `pg_stat_statements`,
not isolated attribution to each HTTP request. These values can be unavailable when the extension
or its reset is unavailable. CPU values can also be unavailable; an existing database has no
container CPU sample.

`--profile [consume|check|reserve]` skips the scenarios, runs fifty sequential requests against the hot
account after a warmup, and lists every statement they execute with its calls per request, rows
and mean execution time from `pg_stat_statements`. `--pg-config setting=value` (repeatable) passes
Postgres settings to the container, for example `synchronous_commit=off` to isolate commit latency.

Options: `--duration` and `--warmup` in seconds, `--concurrency 1,8,32,64`, `--accounts`,
`--scenarios`, `--out file.json`, `--pg-config setting=value` (container only, repeatable), and
`--postgres-uri` to select a disposable existing database instead of a container.

Results from a laptop container are shapes, not capacity: the client, the service and Postgres
share one machine and the container runs Postgres defaults. Quote only figures measured on a sized
instance, and record them together with the source revision they were measured against.

## Reference results

These are the project's baseline figures. Compare a later revision against them on the same
instance type, and record the revision with any new figures.

Measured on 2026-10-09 against `v0.25.1` (`76dad183`) on one Hetzner Cloud CPX42 in Nuremberg:
8 shared vCPUs, 16 GB, Ubuntu 24.04, Bun 1.4.2. The service, the load client and PostgreSQL 18.6
ran on that machine. Postgres used default settings with its data on tmpfs, so disk and commit
latency are not in these figures, and there was no network between the service and the database.
Each level ran 15 seconds after a 2 second warmup, closed loop, on the lane's fixture of 1,000
accounts. The table is the mean of two runs on fresh instances; the two runs differed by 2% to 11%.

| Scenario | Concurrency | Requests/s | p50 ms | p99 ms |
| --- | ---: | ---: | ---: | ---: |
| One account, one feature (consume) | 1 | 37 | 20.6 | 110 |
| One account, one feature (consume) | 32 | 110 | 157.8 | 1,046 |
| 1,000 accounts (consume) | 32 | 604 | 52.7 | 72 |
| 1,000 accounts (reserve, then confirm) | 32 | 379 | 83.7 | 106 |
| 1,000 accounts (check) | 1 | 95 | 10.2 | 29 |
| 1,000 accounts (check) | 32 | 1,051 | 30.0 | 44 |

A reserve iteration is two HTTP calls. An earlier 20 second run of the same metering code at
concurrency 128 reached about 690 consumes per second across 1,000 accounts (p99 215 ms), 390
reserve-and-confirm pairs per second and 1,300 checks per second. With one request per account per
second (`users`), 100 active accounts ran cleanly at p99 68 ms; from 1,000 requested requests per
second the machine accepted about 650 to 680 per second and the rest were dropped as capacity.

What the figures say about sizing:

- **Postgres does the work.** A consume runs about 30 SQL statements and a check about 15. At
  saturation the Postgres container peaked near 4.9 of the 8 cores while the Bun service used about
  half of one core. Size the database for cores first; the API process needs roughly one core per
  instance for the rates above.
- **One account is limited by its row lock.** Consumes against a single account and feature
  serialize on that allocation's row, which a consume holds for several milliseconds. Throughput
  stays near 110 per second however many requests run at once, and extra concurrency only adds
  latency. Spreading the same traffic over many accounts is about five times faster. If one
  customer needs more, send larger quantities per call or reserve and confirm in larger steps.
- **Keep the database close.** A consume makes several database round trips, some in sequence, so
  the latency between the service and Postgres adds directly to request latency. Run them in the
  same region, ideally the same zone.
- **Projection delivery is a separate, slower stage.** Usage projections are coalesced to one job
  per active account, so the backlog is bounded by the number of active accounts. After the load
  stopped, the projection worker delivered about 72 jobs per second to the lane's loopback receiver
  at every `users` level, so bringing 1,000 accounts' projections current takes about 14 seconds
  and 10,000 accounts about two minutes twenty seconds. A real receiver adds its own latency. The
  closed-loop scenarios read the backlog as soon as the load stops, when coalescing leaves about
  one pending job per active account, so a run over many accounts exits non-zero on the backlog
  check; the results file is written first.

These figures do not cover a database on its own host or disk, several API instances, failover,
production admission limits, or provider traffic. Per-request cost changes with every release (the
statement counts above are for this revision), so measure at the revision you run before you
size a deployment.
