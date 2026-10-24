# Implementation Tracker — Distributed Wagering Processor

Last updated: 2026-10-24

Normative files read from `../Jungle Gaming MD/`:
`README_Version2.md`, `ARCHITECTURE_Version2.md`,
`DATABASE_DESIGN_Version2.md`, `DOMAIN_RULES_Version2.md`,
`MESSAGING_AND_OUTBOX_Version2.md`, and `TEST_STRATEGY_Version2.md`.

## FINAL STATUS (authoritative; final engineering review)

Everything below this section is chronological history. Where it says "blocked by EPERM",
"authored but not run" or "not validated", it describes an earlier session state and is
superseded by this section.

Commands run outside the sandbox against local PostgreSQL + LocalStack:
`bun run test:integration` 20/20 (3 files), `bun run test` 40/40, `bun run test:e2e` 10/10 (2 files),
plus `bun run build`, `bun run lint`, `bunx tsc --noEmit`, `git diff --check` passing.
The latest re-run is listed under "Final review re-run" at the end of this file.

| Requirement | State | Evidence |
|---|---|---|
| Money precision, domain math | Validated (unit) | `src/domain/**/*.spec.ts` |
| Same-key idempotency under 50 concurrent calls, payload conflict | Validated (real PostgreSQL) | `test/wagering.integration.ts` |
| 2 × BET 80.00 vs 100.00 → 1 PROCESSED, 1 REJECTED, 20.00, 1 debit | Validated (real PostgreSQL) | `test/wagering.integration.ts` |
| Late reference resolution | Validated (real PostgreSQL) | `test/wagering.integration.ts` |
| Atomic rollback (wallet/ledger/transaction/outbox) | Validated (real PostgreSQL, trigger-forced failure) | `test/messaging.integration.ts` |
| Ledger append-only, CHECK constraints | Validated (real PostgreSQL) | `test/schema.integration.ts` |
| Migrations up/down/up | Validated on empty disposable DB only | `test/schema.integration.ts` |
| SQS consume/ACK-after-commit/Inbox dedup/DLQ | Validated (LocalStack + PostgreSQL) | `test/messaging.integration.ts` |
| Outbox publish after commit, failure retry/recovery | Validated (LocalStack + PostgreSQL) | `test/messaging.integration.ts` |
| HTTP endpoints with real service | Validated (real PostgreSQL + LocalStack queue) | `test/app.db.e2e-spec.ts`; contract cases in `test/app.e2e-spec.ts` (mocked service) |
| Distinct wallets in parallel (12 wallets × 2 bets) | Validated (real PostgreSQL) | `test/messaging.integration.ts` |
| Two Outbox publishers on the same outbox | Validated (two app contexts in one process; real PostgreSQL + LocalStack) | `test/messaging.integration.ts` |
| HTTP contract aligned with the challenge (wallet `initialBalance`/`id`, Money `balance`, reconciliation shape, 201/200/202/422/409/503) | Validated | `src/app.controller.spec.ts`, `test/app.e2e-spec.ts`, `test/app.db.e2e-spec.ts` |
| Commit-then-crash before ACK | Modeled only (no process kill) | `test/messaging.integration.ts` |
| Crash between SQS send and `published_at` | Not tested (mitigation: FIFO dedup id = event id) | — |
| Migration down on populated DB | Intentionally refused; not tested | — |
| Multi-instance (≥3), FIFO ordering with multiple consumers, two concurrent relays | Not tested | — |
| Observe metrics delivery | Implemented, not verified | — |
| Outbox destination queue | Undefined by Version2; `SQS_QUEUE_URL` left unset | — |
| `FAILED` terminal status | Schema only; no code path produces it | — |
| `failureCode` taxonomy | Codes in use: INSUFFICIENT_FUNDS, INVALID_WALLET, INVALID_REFERENCE, REFERENCE_NOT_FOUND, REFERENCE_KIND_NOT_ALLOWED, REFERENCE_ALREADY_REFUNDED/ROLLED_BACK, ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE, AMOUNT_OVERFLOW, IDEMPOTENCY_PAYLOAD_CONFLICT, EXTERNAL_TRANSACTION_CONFLICT | code review |

Review findings fixed: stale README (claimed integration coverage was missing, no API/env/limitations) was
rewritten; `OutboxSqsPublisher` rescheduling after module destroy fixed earlier (`stopping` flag).

## Historical status table (superseded by FINAL STATUS above)

| Requirement | Status | Evidence / limitation |
|---|---|---|
| Exact two-decimal Money and ISO currency validation | VERIFIED | Money unit tests include exact scale, invalid currency, arithmetic, bounds, comparisons, and JSON serialization. |
| BET/WIN/LOSS and REFUND/ROLLBACK math | VERIFIED (domain only) | Unit-tested domain rules; persistence and reference resolution are not proven without PostgreSQL. |
| All Version2 HTTP paths and request routing | VALIDATED (contract + real service) | Controllers expose all nine documented paths. Direct controller tests cover field mapping, money validation, error propagation, reconciliation, liveness, and readiness status; expanded Supertest E2E covers routes/statuses but listener binding failed with sandbox `EPERM`, so HTTP behavior has not been exercised here. Evidence: `test/app.e2e-spec.ts` (mocked service) and `test/app.db.e2e-spec.ts` (real service + disposable PostgreSQL + LocalStack queue for readiness): wallet creation/duplicate, idempotent wager replay, payload conflict 409, missing header 400, insufficient funds REJECTED, balance, ledger, both transaction lookups, reconciliation, 404/400 and live/ready. |
| Wallet constraints and transaction schema | PARTIALLY VALIDATED (PostgreSQL) | Existing constraints plus additive `Migration20261024132700`; PostgreSQL execution remains unverified. The invalid combined `ALTER TABLE ... RENAME COLUMN` action was split into a standalone PostgreSQL command in both `up` and `down`. All six migrations apply on an empty disposable database (`test/schema.integration.ts`). |
| Transaction, wallet, ledger, inbox, and outbox atomicity | VALIDATED (PostgreSQL) | One MikroORM transaction persists state and outbox; Inbox is included for SQS. No DB fault-injection/rollback test has run. Evidence: `test/messaging.integration.ts` forces a real PostgreSQL failure (trigger raising on the outbox insert, and on the ledger insert) after the transaction has begun; balance, ledger, wager transaction and outbox are unchanged, reconciliation stays consistent, the retry commits exactly once and a further retry is an idempotent replay. |
| Persistent idempotency and same-key payload conflict | PARTIALLY VALIDATED (PostgreSQL) | Provider-scoped unique key and canonical SHA-256 hash; transaction-scoped PostgreSQL advisory lock now serializes same provider/key across connections. Integration test asserts 49 replay results and exactly one persisted transaction. Same-key/different-payload integration case added. PostgreSQL execution is blocked in this session. |
| Wallet locking and no negative balance | PARTIALLY VALIDATED (PostgreSQL) | Pessimistic wallet lock, checked arithmetic, and schema constraints; contention test is authored but not run. |
| Append-only directional ledger and reconciliation | VALIDATED (PostgreSQL) | Trigger/checks/mappings and reconciliation code exist; no PostgreSQL trigger or reconciliation test was run. Evidence: `test/schema.integration.ts` on a disposable DB: UPDATE, DELETE and TRUNCATE are rejected by the trigger (`ledger_entries is append-only`), inconsistent balance rows hit `ledger_entries_balance_consistent`, negative wallet balance hits `wallets_balance_non_negative`. Reconciliation consistency is asserted after the atomicity cases. |
| Reference pending/retry/TTL | PARTIALLY VALIDATED (PostgreSQL) | Persisted pending state, outbox event, worker/backoff/TTL; real-DB recovery test authored but not run. |
| SQS versioned envelope, Inbox deduplication, FIFO metadata, ACK/retry | VALIDATED (LocalStack + PostgreSQL) | AWS SDK consumer, `(consumerName,messageId)` unique key, post-commit ACK, and redrive queue setup exist. Parser contract has unit tests. `bun run infra:sqs` previously failed with TCP refusal; no real LocalStack message processing evidence. Evidence: `test/messaging.integration.ts` real LocalStack FIFO queues: message consumed and committed then ACKed; redelivery with same messageId deduplicated by Inbox (one debit); commit-without-ACK then redelivery is a no-op; failed commit is NOT ACKed and succeeds on redelivery; repeatedly failing message reaches the DLQ (maxReceiveCount 2) with no financial effect. The ACK-before-crash case is modelled by committing through the same use case without ACK, not by killing the process. |
| Transactional Outbox, bounded retry/jitter and event metrics | VALIDATED (LocalStack + PostgreSQL) | FIFO group/dedup IDs, `SKIP LOCKED` claim, retry/final failure, correlation/causation envelope, and Observe custom metrics are wired. Updates now use forked EntityManager. No SQS/telemetry delivery evidence. Evidence: committed events are published to a real SQS queue; a rolled-back transaction produces no outbox row and no message; a publication failing because the queue is missing records `last_error`/attempts and is delivered after the queue returns. Not covered: crash between SQS send and `published_at` update (mitigated by MessageDeduplicationId = event id), Observe delivery, and the Outbox destination queue (undefined by Version2). |
| Outbox destination queue | NOT IMPLEMENTED / CONTRACT BLOCKED | Version2 names the input FIFO queue and DLQ but does not name the separate event destination. `SQS_QUEUE_URL` must point to the approved queue; none is invented or created. |
| FAILED transaction terminal state | NOT IMPLEMENTED | Status is modeled in persistence, but no permanent-infrastructure failure path creates an auditable `FAILED` transaction. |
| Reversible migrations | VALIDATED (empty disposable DB only) | Down migrations now remove only the opening-balance backfill and guard against dropping populated financial tables. PostgreSQL up/down has not been tested; rollback is refused when application data exists to prevent data loss. Evidence: `migrator.up()`, `down({to: 0})`, `up()` in a disposable database. Not covered: down with populated data (the migrations refuse destructive rollback by design); never run against the local database. |
| PostgreSQL concurrency integration | VALIDATED (4/4 passed, 2026-10-24 16:22) | `test/wagering.integration.ts` covers 50 same-key requests (including persisted-row count), two 80.00 bets against 100.00, late reference resolution, and same-key/different-payload conflict. PostgreSQL execution was blocked by `EPERM`; no database behavior is claimed as verified in this session. |
| HTTP/PostgreSQL/SQS E2E and recovery matrix | NOT IMPLEMENTED / NOT VALIDATED | Supertest E2E now includes all documented API paths and selected invalid/error cases, but every case is blocked at listener bind (`EPERM`). Controller unit tests cover direct handler mapping. Crash-before-ACK, multiple app instances, publisher races, atomic rollback, real SQS redelivery/DLQ, and migration down remain untested. |
| Operational metrics and structured logs | IMPLEMENTED NOT INTEGRATION-TESTED | Observe counters/summary/gauge and structured financial/outbox logs are wired; collector credentials and delivery are unverified. |

## Commands and observed checks

Executed successfully:

- `bun run test` — 3 files, 33 tests passed.
- `bun run build` — passed.
- `bun run lint` — passed.
- `bunx tsc --noEmit` — passed, including integration and queue-setup TypeScript.
- `git diff --check` — passed.
- `docker compose config --quiet` — passed configuration parsing.
- `./node_modules/.bin/mikro-orm --help` — confirmed CLI availability.

Blocked / not validated:

- `bun run test:e2e` — fails at loopback bind with `listen EPERM`; HTTP routes were not exercised.
- `docker compose ps` — cannot connect to `/var/run/docker.sock` (`no such file or directory`; Docker config read also returned `operation not permitted`); container health and logs cannot be inspected from this process.
- `bun run migration:list` — executed again; fails with `EPERM` connecting to both `::1:5432` and `127.0.0.1:5432`. Migrations were not applied.
- `bun run infra:sqs` — fails with `ECONNREFUSED` connecting directly to `localhost:4566`; queues were not created. The Bun runtime environment has HTTP(S)_PROXY variables set and no loopback entry in NO_PROXY. The earlier health request returned HTTP 200 via the proxy path; direct `curl --noproxy '*'` and the AWS SDK connection failed, so that response does not prove direct access to a healthy local container.
- `bun run test:integration` — executed; the suite failed to connect to both PostgreSQL loopback addresses with `EPERM`; all 3 integration tests were skipped and none passed.
- Migration up/down and live SQS message/worker validation remain unrun because the required PostgreSQL and SQS connections are unavailable.

## PostgreSQL Migration20261024132700 syntax correction (2026-10-24)

- Root cause: `RENAME COLUMN` is a standalone `ALTER TABLE` command in
  PostgreSQL 17, not an action that can be comma-combined with other
  `ALTER TABLE` subcommands. The `up` migration combined
  `rename column "type" to "kind"` with `ALTER COLUMN ... SET NOT NULL`,
  producing the reported syntax error at `rename`. The `down` migration had
  the same invalid command shape.
- Correction: split each column rename into its own `ALTER TABLE` statement.
  Other standalone table/index renames were already separate and remain so.
  No new migration was added; this corrects the unapplied migration itself,
  rather than adding another migration that cannot safely repair a failed,
  unrecorded migration.
- Migration state could not be read: `bun run migration:list` failed before
  querying the migration table with `EPERM` on both loopback addresses.
  `bun run migration:up` likewise failed at connection acquisition, before
  PostgreSQL executed the corrected SQL. Therefore whether the earlier failed
  attempt left any database-side changes is not directly verified here.
- MikroORM's installed defaults show `migrations.transactional: true`, and
  `Migration.isTransactional()` returns `true`; its runner wraps migration
  statements in a transaction. This indicates the reported SQL error should
  roll back the migration transaction, but the actual database state still
  requires confirmation via `migration:list` on the database.
- Post-correction results: `bun run test` passed (33 tests), `bun run build`,
  `bun run lint`, `bunx tsc --noEmit`, and `git diff --check` passed.
  `bun run infra:sqs` failed with `ECONNREFUSED`; `bun run migration:list`
  and `bun run migration:up` failed before SQL execution with `EPERM`;
  `bun run test:integration` failed to connect (3 skipped, 0 passed);
  `bun run test:e2e` failed binding `127.0.0.1` with `EPERM`. No schema or
  integration success is claimed.

## Local validation retry (2026-10-24 15:07)

Commands rerun in the requested validation sequence:

- `docker compose ps` — failed to connect to `/var/run/docker.sock`;
  container health and logs remain unavailable.
- `bun run infra:sqs` — failed with `ECONNREFUSED` on IPv6 and IPv4 loopback
  at port 4566; no queue URL or SQS configuration could be verified.
- `bun run migration:list` and `bun run migration:up` — both failed before
  querying or modifying the database with `EPERM` on `::1:5432` and
  `127.0.0.1:5432`. No migrations were applied by these attempts; current
  migration history and schema remain unknown.
- `bun run test:integration` — failed on PostgreSQL connection with `EPERM`;
  3 integration tests skipped, 0 passed.
- `bun run test:e2e` — failed opening the HTTP listener with
  `listen EPERM: operation not permitted 127.0.0.1`; no route was exercised.
- Final checks: `bun run test` passed (33 tests); `bun run build`,
  `bun run lint`, `bunx tsc --noEmit`, and `git diff --check` passed.

PostgreSQL constraints, indexes, foreign keys, and financial tables have not
been inspected in the actual database. HTTP endpoint status codes, response
schemas, validation, and real financial effects have not been exercised over
HTTP. SQS FIFO/DLQ existence, redrive settings, Inbox ACK/redelivery, and
Outbox publication/recovery are also unverified. Run the documented validation
sequence from an authorized local terminal with Docker socket and loopback
access; do not treat the proxy-routed LocalStack health response as proof of
direct local service health.

## EPERM environment diagnosis (2026-10-24)

- Bun's process sees `.env` PostgreSQL settings (`POSTGRES_HOST=localhost`,
  port `5432`; database, user, and password are set). Values were inspected
  without printing credentials.
- The local `.env` does not set `SQS_ENDPOINT_URL`, `AWS_REGION`, or AWS
  credentials. `infra:sqs` has safe defaults for the endpoint/region and local
  dummy credentials; the AWS SDK then attempts direct TCP to loopback and
  receives `ECONNREFUSED`.
- Docker Compose container status and logs cannot be retrieved because this
  execution context cannot access the Docker daemon socket. Thus it is unknown
  whether containers are running or healthy on the host.
- PostgreSQL migration/integration commands and the HTTP E2E listener fail
  with `EPERM` on loopback; these are OS-level permission failures from this
  execution context, not evidence of incorrect PostgreSQL credentials. The
  E2E bind failure is likewise not an application HTTP response.
- The proxy variables with no loopback `NO_PROXY` entry explain why a proxied
  LocalStack health request could return 200 while direct loopback access
  fails. Do not treat the proxied health result as local container health.
- No security controls were weakened and `.env` was not changed. No
  application/configuration defect can be proven to cause the PostgreSQL
  `EPERM`; direct host-terminal validation is required before migrations or
  integration tests can be safely run.

Run the following from an authorized local terminal in this repository, where
Docker socket and loopback access are available:

```bash
docker compose ps
docker compose logs --tail=100 postgres localstack
bun run infra:sqs
bun run migration:list
bun run migration:up
bun run test:integration
bun run test:e2e
```

## Local validation sequence

```bash
cp -n .env.example .env
docker compose up -d postgres localstack
bun run infra:sqs
# Set the printed SQS_INBOX_QUEUE_URL and SQS_DLQ_QUEUE_URL in .env.
# Set SQS_QUEUE_URL only after the Outbox destination contract is supplied.
bun run migration:up
bun run test:integration
bun run start:dev
bun run test:e2e
```

The integration suite creates uniquely identified financial records and does
not clean or reset the configured database. Do not point it at production.

## Integration failure fixes (2026-10-24 15:11)

- **Same-key idempotency race:** if the first idempotency lookup misses but
  the subsequent external-transaction lookup sees a concurrently committed
  row, the service re-reads `(providerId, idempotencyKey)` before treating the
  external ID as a conflict. A matching payload hash replays the existing
  result; a different payload remains an idempotency conflict. Database
  uniqueness constraints were preserved.
- **MikroORM context:** wallet, transaction, and provider-transaction lookups,
  plus read-only SQL paths, now use `orm.em.fork({ clear: true })` instead of
  context-specific operations through the global EntityManager.
- **Late reference:** behavior remains implemented via the existing persisted
  retry worker, but could not be exercised after the context fix because the
  current process cannot reach PostgreSQL.
- `bun run test:integration` was attempted once after these changes and
  failed before test setup with `EPERM` connecting to both `::1:5432` and
  `127.0.0.1:5432`; 3 tests were skipped, 0 passed. The user-reported local
  migration success cannot be independently confirmed from this runtime.
- Post-change checks: `bun run test` passed (33 tests), `bun run build`,
  `bun run lint`, `bunx tsc --noEmit`, and `git diff --check` passed.

## Final compliance audit / same-key concurrency hardening (2026-10-24 15:22)

- All six sibling `*_Version2.md` requirement files were found. The available
  requirements were compared with the current source, `package.json`,
  Compose configuration, tests, migrations, and this tracker.
- **Idempotency correction:** `process()` obtains
  `pg_advisory_xact_lock(hashtextextended(JSON.stringify([providerId,
  idempotencyKey]), 0))` inside the same SQL transaction before Inbox or
  transaction lookups. Concurrent calls with that key now serialize across
  application connections/instances; the persisted unique constraints remain
  as backstops. The integration test now asserts one matching persisted row,
  49 replays, and adds a same-key/different-payload conflict case.
- **EntityManager review:** wallet, transaction, provider-transaction and
  read-only query paths use contextual forks; `allowGlobalContext` is not
  enabled.
- **Finance/schema static evidence:** money arithmetic is based on minor-unit
  `bigint`; entity fields map monetary units to PostgreSQL bigint with explicit
  currency. Wallet non-negative and ledger arithmetic checks, unique
  transaction/reversal constraints, foreign-key relations, and append-only
  triggers exist in entities/migrations. These are code/schema-definition
  evidence, not verification of the live database in this environment.
- **Test coverage gap:** `vitest.config.e2e.ts` discovers E2E specs, but
  `test/app.e2e-spec.ts` only exercises `GET /`. Selected API mappings and
  readiness are checked in controller unit tests. The full endpoint contract
  has not been exercised over HTTP.
- **Messaging coverage gap:** the PostgreSQL integration module overrides
  SQS consumer and publisher. Those tests are database-financial tests, not
  SQS integration tests. No real LocalStack consume/ACK/redelivery or
  Outbox-publish test is present. The Outbox destination remains undefined by
  Version2 and must not be invented.
- The user reports migrations were applied successfully on their local Mac;
  this session cannot verify that state. Its PostgreSQL test command was not
  retried after the immediate `EPERM` block documented above.
- After the concurrency/test changes: `bun run test` passed (3 files,
  33 tests); `bun run build`, `bun run lint`, `bunx tsc --noEmit`, and
  `git diff --check` passed. `bun run test:integration` remains blocked before
  test execution with `EPERM` to `::1:5432` and `127.0.0.1:5432`. No
  PostgreSQL integration or SQS behavior is marked verified.

## Integration retry from current request (2026-10-24 15:19)

- Inspected `src/application/wager-transaction.service.ts`,
  `test/wagering.integration.ts`, and the tracker before making changes.
  No additional code changes were justified by the reported database failure.
- Command run in the available VS Code/Bun terminal:
  `bun run test:integration`
- Exact result before tests started: `Error: connect EPERM ::1:5432 - Local
  (:::0)` and `Error: connect EPERM 127.0.0.1:5432 - Local (0.0.0.0:0)`.
  Vitest reported `Tests 3 skipped (3)` and exit code 1. None of the three
  database-backed cases executed in this run.
- This process cannot use the user's authorized Mac terminal. The result
  demonstrates the execution environment still blocks local PostgreSQL
  connections; it does not show whether the user's reported host migration
  success or service health is correct.
- No DB settings, migrations, constraints, volumes, records, or mock
  implementations were changed. The three scenarios (50-request idempotency,
  concurrent 80.00 bets, late rollback reference) remain unverified until
  `bun run test:integration` is run from the authorized terminal.

## PostgreSQL integration access recheck (2026-10-24 15:15)

- Re-ran `bun run test:integration`; before integration setup, the PostgreSQL
  driver reported `Error: connect EPERM ::1:5432 - Local (:::0)` and
  `Error: connect EPERM 127.0.0.1:5432 - Local (0.0.0.0:0)`. Vitest reported
  3 skipped tests and 0 passed.
- Inspected the environment inherited by Bun without printing secrets:
  `POSTGRES_HOST=localhost`, `POSTGRES_PORT=5432`, and database/user/password
  variables are present. This matches the configured local endpoint; no
  evidence indicates a malformed host or port. HTTP(S)_PROXY and ALL_PROXY
  are set to the environment's loopback proxy, with no NO_PROXY value.
- `docker compose ps` cannot contact `/var/run/docker.sock` (path absent to
  this execution context; Docker config access also returns `operation not
  permitted`), so PostgreSQL/LocalStack container health and logs cannot be
  inspected here. The previously reported healthy containers are not
  independently confirmed in this run.
- Diagnosis: the current process is denied access to loopback PostgreSQL by
  the execution environment before database authentication or test queries.
  The full error is `EPERM`, not connection refusal/authentication failure.
  No application connection setting was changed because the configured
  address is consistent with the local Compose port mapping and there is no
  evidence of an application configuration defect.
- No workaround, mock, schema change, migration change, or data operation was
  performed. Integration remains unvalidated. Re-run `bun run test:integration`
  from the user's authorized local terminal/session with Docker and loopback
  access enabled; if it then fails beyond connection setup, capture and fix
  that database/test failure separately.

## Compliance audit and idempotency lock update (2026-10-24 15:22)

- Confirmed all six normative `*_Version2.md` files are accessible in the
  sibling `Jungle Gaming MD` folder; checked their domain, schema,
  architecture, messaging, API, and testing requirements against source,
  migrations, Compose, tests, and package scripts.
- Added `pg_advisory_xact_lock(hashtextextended(...))` inside the transaction
  before idempotency/inbox lookup. The lock identity combines provider and
  idempotency key; uniqueness constraints remain intact as durable backstops.
  This addresses the observed race in code, but is **not yet verified on
  PostgreSQL**.
- Extended the PostgreSQL integration test to assert 49 replay results and one
  persisted transaction row for 50 submissions, and added same-key/different
  payload conflict coverage with no extra wallet/ledger effect. Existing
  integration cases retain the 80.00-vs-100.00 concurrency and delayed
  rollback-reference checks.
- `getWallet`, `getTransaction`, provider transaction, reconciliation,
  readiness, and other read-only database paths use EntityManager forks;
  `allowGlobalContext` is not enabled.
- This session did not repeat `bun run test:integration` after the immediate
  `EPERM` at `::1:5432` and `127.0.0.1:5432` recorded above. That error
  preceded the latest advisory-lock/test changes, so their database behavior
  remains unknown. The prior attempt had 3 skipped, 0 passed.
- After these changes, `bun run test` passed (3 files, 33 tests),
  `bun run build`, `bun run lint`, `bunx tsc --noEmit`, and `git diff --check`
  passed. The latest `git diff --check` was rerun after tracker edits.
- Static audit confirms integer minor units / bigint schema, wallet balance
  checks, directional ledger arithmetic checks, transaction/reversal
  uniqueness, FK mappings, and append-only triggers are present. Live schema,
  concurrency, and financial invariants remain unverified here.
- HTTP gap: `test/app.e2e-spec.ts` only covers `GET /`; controller unit tests
  cover selected mapping and readiness, not every documented route over HTTP.
- SQS gap: PostgreSQL financial integration tests replace the consumer and
  publisher; no real LocalStack test exercises FIFO/DLQ, Inbox ACK/redelivery,
  or Outbox publication. Outbox destination remains contractually unspecified.
- README follow-up: qualify claims of multi-instance and real PostgreSQL/SQS
  integration verification to match evidence. No root
  `ARCHITECTURE.md`, `DOMAIN_RULES.md`, `DATABASE_DESIGN.md`,
  `MESSAGING_AND_OUTBOX.md`, or `TEST_STRATEGY.md` exists; do not copy the
  external Version2 files automatically. Any future local versions should
  distinguish implemented design from integration evidence.

## Final validation and coverage closure work (2026-10-24 15:31)

- Readiness now checks PostgreSQL `select 1` and `GetQueueAttributes` for the
  configured `SQS_INBOX_QUEUE_URL`; it returns not-ready when the input queue
  or region is unconfigured or either dependency is unreachable. No Outbox
  destination was assumed. The service method is named `checkReadiness`.
- Outbox success/failure updates now use a forked EntityManager for
  context-specific `nativeUpdate` operations. No global-context option was
  enabled.
- Expanded `test/app.e2e-spec.ts` with Supertest coverage for wallet create,
  wallet/ledger reads, transaction lookups, wager submission,
  reconciliation, live/ready checks, validation errors, not-found, conflict,
  and status/body contracts. The E2E suite uses an isolated mock application
  service for HTTP adapter behavior only; it does not replace PostgreSQL/SQS
  integration tests or claim financial integration.
- Expanded controller unit tests to cover routing/mapping and error paths;
  added isolated SQS envelope parser tests (valid envelope, malformed JSON,
  unsupported event and invalid operation).
- `bun run test` after these changes: **4 files, 40 tests passed**.
- `bun run build`: passed.
- `bun run lint`: passed.
- `bunx tsc --noEmit`: passed.
- `git diff --check`: passed.
- `bun run test:e2e`: attempted; 6 HTTP tests could not bind the server and
  failed with `listen EPERM: operation not permitted 127.0.0.1`. No HTTP
  endpoint test executed successfully.
- `bun run test:integration` was not repeated in this phase because the most
  recent identical connection attempt already failed before test setup with
  `EPERM` for `::1:5432` and `127.0.0.1:5432`; no integration result after the
  advisory-lock change is available. Actual PostgreSQL financial assertions
  remain pending.
- Real LocalStack/SQS checks were not rerun: Docker socket remains inaccessible
  in this runtime, and earlier direct SDK connections received
  `ECONNREFUSED`. Parser unit tests are not SQS integration evidence.
- Further closure work required: in the user's authorized terminal with
  loopback/Docker access run `bun run test:integration`, `bun run test:e2e`,
  and `bun run infra:sqs`; add/execute real SQS Inbox/Outbox recovery tests;
  verify runtime readiness against actual dependencies; qualify README's
  unverified integration and multi-instance claims. Keep SQS Outbox
  destination unresolved until its contract is supplied.


## Integration run on real PostgreSQL (2026-10-24 16:22)

- Earlier run with real DB access: all 4 tests timed out at 30s (151s total). Root cause: `em.getConnection().execute()` inside `em.transactional()` does not use the transaction connection, so `pg_advisory_xact_lock` ran on a separate pool connection in autocommit mode (lock released immediately, extra pool connections consumed under 50-way concurrency). The same flaw existed in the Outbox claim query.
- Fix: use `em.execute()` (transaction-aware) in `wager-transaction.service.ts` and `outbox-sqs-publisher.service.ts`.
- `bun run test:integration`: 4 passed / 4 (50 same-key submissions, payload conflict, 80+80 vs 100.00, late-reference rollback).
- `bun run test` 40/40; `bun run test:e2e` 6/6; `bun run build`, `bun run lint`, `bunx tsc --noEmit`, `git diff --check` passed.
- Still not validated: real LocalStack SQS consume/ACK/redelivery/DLQ and Outbox delivery; migration down; trigger/fault-injection tests. Earlier rows marked NOT INTEGRATION-TESTED for these remain accurate.

## Persistence and messaging verification (2026-10-24 16:40)

New tests, all running against real PostgreSQL (disposable per-run database, created and force-dropped by `test/support/disposable-database.ts`; the local `wagering` database is never touched) and real LocalStack SQS:
- `test/schema.integration.ts` (7): migrations up/down/up; ledger immutability; constraints.
- `test/messaging.integration.ts` (9): atomic rollback (2), SQS consumer (4), DLQ (1), outbox (2).
- `test/app.db.e2e-spec.ts` (4): HTTP with the real financial service.
- Defect fixed: `OutboxSqsPublisher` kept rescheduling its loop after module shutdown (observed as connection errors after the test database was dropped); it now stops on destroy.

Commands: `bun run test:integration` (20 passed), `bun run test:e2e` (10 passed; needs PostgreSQL + LocalStack), `bun run test` (40 passed).

Not validated: multi-instance deployment; process kill between commit and ACK (modelled, not killed); Observe metrics delivery; FIFO ordering under many consumers; `down` with populated data. The test harness needs loopback access and cannot run inside the restricted sandbox (`EPERM`).
## Final review re-run (2026-10-24 16:47, outside sandbox)

- `bun run test:integration`: 3 files, 20/20 passed (expected ERROR log lines come from the deliberate missing-queue Outbox test).
- `bun run test:e2e`: 2 files, 10/10 passed.
- `bun run test`: 4 files, 40/40 passed.
- `bun run build`, `bun run lint`, `bunx tsc --noEmit`: exit 0. `git diff --check`: no output.
- No tests were skipped. No code changed in this review; only README.md and this tracker.

## Challenge-alignment re-run (2026-10-24 17:00)

After aligning the HTTP contract with the challenge README, adding ARCHITECTURE.md, the 503 filter, and the parallel-wallet and two-publisher tests: `bun run test:integration` 22/22, `bun run test:e2e` 10/10 (both outside the sandbox), `bun run test` 44/44, build/lint/tsc exit 0.

## Compliance remediation (sections 6.0, 12, 13) - observed results

Run outside the sandbox against local PostgreSQL + LocalStack:
- `bun run test` 59/59 (5 files, includes `src/domain/domain-model.spec.ts`).
- `bun run test:integration` 23/23 (4 files, includes `test/metrics.integration.ts`).
- `bun run test:e2e` 10/10. `bun run test:process` 3/3 (new, `test/multi-process.process.ts`).
- `bun run build`, `bunx tsc --noEmit`, `git diff --check` clean; `bun run lint` exits 0 with 2 `restrict-template-expressions` warnings in the process test.

Evidence:
- Section 13 test 4: 3 `node dist/main.js` processes (distinct pids), 8 wallets, duplicate deliveries: 16 BET transactions, one DEBIT per wallet, outbox fully published, ledger == balance.
- Section 13 test 5: crash worker commits then stalls before ACK; SIGKILL; survivor drains the queue; 1 transaction, 1 DEBIT, outbox published, consistent.
- Section 13 test 8: SIGKILL one worker and SIGTERM another under load (40 messages), restart 2 workers: 40 BET transactions, queue drained, consistent.
- Section 12 metrics: lock-conflict (both kinds) and latency recorded under contention in the metrics integration test.
- Wallet creation writes an OPENING transaction and an outbox event; process-test counts account for it.

Still open: FAILED never produced; no test:load; 503 tested with a simulated error only; Observe delivery unverified; FIFO ordering with several consumers untested; send-to-SQS vs published_at window untested; auth not implemented (no-op guard only); InboxMessage / OutboxMessage retry domain classes not wired.

## Final documentation pass - observed results

Fixed the two `restrict-template-expressions` warnings in `test/multi-process.process.ts` (pids and counts are now converted with `String(...)`/`join`; assertions unchanged). This supersedes the lint warning note above.
Re-run (integration, E2E and process suites outside the sandbox, real PostgreSQL + LocalStack): `bun run test` 59/59, `bun run test:integration` 23/23, `bun run test:e2e` 10/10, `bun run test:process` 3/3, `bun run build` ok, `bun run lint` exit 0 with no warnings, `bunx tsc --noEmit` ok, `git diff --check` clean. README.md was rewritten; no code behavior changed.
