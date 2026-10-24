# Architecture and decisions

Scope: what is implemented, why, trade-offs and limitations. Evidence for each claim is in
`IMPLEMENTATION_TRACKER.md`; setup and commands are in `README.md`.

## 1. Layers

- **Interface**: `src/app.controller.ts` (HTTP), `src/application/sqs-inbox-consumer.service.ts` (SQS).
  Both call the same use case, `WagerTransactionService.process()`.
- **Application**: `wager-transaction.service.ts` (transaction orchestration, reconciliation,
  pending-reference worker), `outbox-sqs-publisher.service.ts` (Outbox relay), `wager-metrics.service.ts`.
- **Domain**: `src/domain` — `Money` (immutable value object, no ORM/Nest dependency) and the pure
  balance rules in `wagering.rules.ts`.
- **Persistence**: `src/database` — MikroORM entities and reversible migrations.

Domain classes with `create`/`open`/`enqueue`/`rehydrate` factories exist in `src/domain` (`Wallet`, `WalletLedgerEntry`, `WagerTransaction` with a documented transition table, `IntegrationEvent` hierarchy, `OutboxMessage`, `InboxMessage`). `Wallet`, `WalletLedgerEntry`, `IntegrationEvent`, `OutboxMessage.enqueue` and the `WagerTransaction` transition guard are wired into the service; `InboxMessage` and `OutboxMessage.scheduleRetry` are not (relay and inbox use SQL). Persistence still uses MikroORM entities. The financial guarantees do not depend on that split (they are enforced by
the schema and the transaction), but the domain model is less rich than the challenge's reference skeleton.

## 2. ORM and transaction strategy

MikroORM was chosen for `EntityManager.transactional()`, `LockMode.PESSIMISTIC_WRITE` and an explicit Unit of
Work. Each operation runs in one `em.transactional()`. Raw SQL inside it must use the transactional
`em.execute()` (not `em.getConnection().execute()`, which uses a different connection — this caused the advisory
lock and the Outbox claim to run outside the transaction until it was fixed). Reads outside transactions use
`em.fork({ clear: true })`; `allowGlobalContext` is not enabled.

## 3. Money

- API/domain: string decimal with exactly 2 fractional digits (`"25.00"`); no `number`, `float` or `double`.
  Rejects NaN, scientific notation, empty strings, >2 decimals, negatives, invalid ISO-4217 currency.
- Persistence: `amount_minor`/`balance_minor` as `bigint` plus `currency char(3)`; arithmetic uses `bigint`.
- Events carry `{ amount, currency }` strings, never a `Money` instance.
- Cross-currency operations are rejected (`INVALID_WALLET` for a wallet/currency mismatch; `Money` throws on mixed arithmetic).

## 4. Concurrency

The concurrency unit is the wallet. Strategy: **pessimistic lock** (`SELECT ... FOR UPDATE` via
`PESSIMISTIC_WRITE`) on the wallet row inside the transaction, then checked arithmetic. No global lock; different
wallets proceed in parallel. `wallets.version` is incremented only when the balance changes. Trade-off: hot wallets
serialize, in exchange for no retry loops and no lost updates. Correctness rests on the database, so it does not
depend on a single application instance (multi-instance behavior is **not tested**, see limitations).

## 5. Idempotency

- `Idempotency-Key` header is required (HTTP). For SQS the message `data.idempotencyKey` is used.
- Unique constraints `(provider_id, idempotency_key)` and `(provider_id, external_transaction_id)` are the final guard.
- `pg_advisory_xact_lock(hashtextextended(JSON.stringify([providerId, idempotencyKey]), 0))` at the start of the
  transaction serializes same-key requests only (other keys are not blocked), so concurrent duplicates become
  replays rather than unique-violation errors.
- `payloadHash` = SHA-256 (hex) of the JSON with recursively sorted keys over the business fields
  (provider, external id, player, wallet, round, game, kind, amount, currency, reference). The header and transport
  metadata are excluded. Same key + same hash → replay (`idempotentReplay: true`, original result); different hash → 409.
- No in-memory cache is used for idempotency.

## 6. Ledger and reconciliation

`wallet_ledger_entries` is append-only: a trigger rejects UPDATE, DELETE and TRUNCATE; CHECK constraints enforce
`balance_before ± amount = balance_after`, `amount > 0` and non-negative balances; `wallets.balance_minor >= 0` is a
CHECK. At most one entry per transaction/wallet. `LOSS` and `REJECTED` transactions create no entry.
`POST /wallets/:id/reconciliation` compares `wallets.balance_minor` with the ledger sum, returns
`storedBalance`, `calculatedBalance`, `difference`, `consistent`, `checkedEntries`, logs a mismatch and increments a
metric; it never repairs anything.

## 7. Transaction states

`PENDING → PROCESSED | REJECTED | PENDING_REFERENCE`; `PENDING_REFERENCE → PROCESSED | REJECTED`.
`PROCESSED` and `REJECTED` are terminal and updates are conditional on the current status.
`FAILED` exists in the schema but **no code path produces it yet**.
`OPENING` is internal: it is created only by `POST /wallets` and is rejected from API and SQS input.

### Reversals and references

`REFUND` → only `BET`; `ROLLBACK` → `BET`, `WIN` or `REFUND`. The reference is resolved by
`(providerId, referenceExternalTransactionId)` and must match provider, player, wallet, currency, round and amount.
A reference can be reversed once per type. A missing/unprocessed reference stores `PENDING_REFERENCE`; a scheduled
worker retries with exponential backoff until `PENDING_REFERENCE_MAX_ATTEMPTS` (default 10) or
`PENDING_REFERENCE_TTL_MINUTES` (default 60), then rejects with `REFERENCE_NOT_FOUND` and emits
`WagerTransactionRejected`.

### failureCode taxonomy (stable, machine-readable)

| Code | Meaning | Provider action |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET above balance | do not resend |
| `INVALID_WALLET` | wallet belongs to another player or currency differs | fix payload |
| `INVALID_REFERENCE` | reference differs in player/wallet/currency/round/amount | fix payload |
| `REFERENCE_KIND_NOT_ALLOWED` | reference kind not allowed for REFUND/ROLLBACK | fix payload |
| `REFERENCE_NOT_FOUND` | reference never arrived within attempts/TTL | resend after the original |
| `REFERENCE_ALREADY_REFUNDED` / `REFERENCE_ALREADY_ROLLED_BACK` | already reversed by the same operation type | give up |
| `ROLLBACK_WOULD_CAUSE_NEGATIVE_BALANCE` | reversal would push the balance below zero (distinct from `INSUFFICIENT_FUNDS`) | manual review |
| `AMOUNT_OVERFLOW` | amount outside the bigint range | fix payload |
| `IDEMPOTENCY_PAYLOAD_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT` | same key/external id with different content (SQS path; HTTP answers 409) | use a new key |

## 8. HTTP status mapping

| Situation | Status |
|---|---|
| Transaction applied | 201 (replay of an applied transaction: 200) |
| Accepted, waiting for the reference (`PENDING_REFERENCE`) | 202 |
| Business rejection (`REJECTED` + `failureCode`) | 422 |
| Invalid payload / header / id | 400 |
| Unknown wallet or transaction | 404 |
| Idempotency payload conflict, duplicate wallet | 409 |
| Dependency down (readiness) | 503 |
| Transient infrastructure error (connection refused/reset, timeout, deadlock, serialization failure) | 503 with `Retry-After` |
| Anything else unexpected | 500 |

The 503 mapping is implemented by `InfrastructureExceptionFilter` (unit/mocked-service tests only; it has not been
triggered by a real database outage).

## 9. Messaging

- **Consumer**: validate the envelope → `process()` with the Inbox identity `(consumerName, messageId)` → single
  SQL transaction (inbox + wager + wallet + ledger + outbox) → ACK (`DeleteMessage`) only after commit. A
  business rejection is terminal and ACKed; any other error is not ACKed, so SQS redelivers after the visibility
  timeout and the queue redrive policy (`maxReceiveCount`) moves it to the DLQ. Structurally invalid messages are not
  retried forever: they follow the same redrive path. The Inbox also stores the payload hash to detect a reused `messageId`.
- **Outbox**: events are inserted in the business transaction. The relay claims due rows with
  `FOR UPDATE SKIP LOCKED` (batch size configurable), pushes `next_attempt_at` forward, sends to SQS FIFO with
  `MessageGroupId = aggregate_id` and `MessageDeduplicationId = event id`, then sets `published_at`. Failures increment
  `attempts`, store `last_error`, back off exponentially with jitter and, after `OUTBOX_MAX_ATTEMPTS`, set `failed_at`.
  Delivery is at-least-once; consumers must dedupe by `eventId`.
- **Destination queue**: the reference documents do not define one, so `SQS_QUEUE_URL` is left unset by default
  and events remain pending until it is configured. No queue was invented.
- **Shutdown**: `enableShutdownHooks()`; on module destroy the consumer stops polling and the relay stops rescheduling.
  In-flight messages that do not finish are not ACKed and return after the visibility timeout. This is **not** tested
  with a real SIGTERM.

## 10. Authentication

Not implemented (it carries no weight in the evaluation). Intended design: an external OIDC provider (Keycloak or
Zitadel) validated by a NestJS guard in front of the HTTP controllers; `/health/*` stay public and queue messages are a
trusted internal channel (their provider identity is still validated by domain rules). The extension point exists: a no-op `AuthGuard` (`src/auth.guard.ts`) registered as `APP_GUARD`.

## 11. Observability

Structured JSON logs with `correlationId`, `transactionId`, `walletId`, `providerId`, no full financial payloads;
Observe custom metrics: consumed messages by status, inbox duplicates, idempotency conflicts, reconciliation mismatches,
consumer retries, outbox published/failed counters, outbox lag, DLQ depth gauge. Also `wager_lock_conflicts_total` (label `kind`: `idempotency_key` via failed `pg_try_advisory_xact_lock`, `wallet_row` via a `FOR UPDATE SKIP LOCKED` probe) and `wager_processing_duration_ms` (summary, label `http|sqs`). Logs are JSON unless `LOG_FORMAT=text`. Delivery to Observe is not verified.

## 12. Limitations

See "Known limitations" in `README.md`: process kill between commit and ACK (modeled only), send-to-`published_at`
window, migration `down` on populated data (refused by design), multi-instance (≥3) and FIFO ordering with multiple
consumers (untested), `FAILED` status unused, Observe delivery unverified, restart-under-load scenario untested.
