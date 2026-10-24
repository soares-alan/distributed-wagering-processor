# Distributed Wagering Processor

A backend service for reliable wagering transaction processing, designed around financial correctness, persistent idempotency, concurrency control, and resilient asynchronous messaging.

> **Status:** In development. The repository's `main` branch currently contains the initial NestJS scaffold. Additional database and wallet work has been validated in the local development environment and is being brought into version control incrementally.

## Project Goals

The system is being designed to process wagering operations safely when requests are duplicated, transactions execute concurrently, messages are redelivered, events arrive out of order, or infrastructure temporarily fails.

The central financial invariant is:

```text
wallet.balance == balance reconstructed from the wallet ledger
```

## Technology Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Application framework:** NestJS
- **Database:** PostgreSQL
- **ORM and migrations:** MikroORM
- **Messaging target:** AWS SQS, with a local SQS-compatible environment such as LocalStack or MiniStack
- **Testing:** Vitest, with unit, integration, and concurrency scenarios planned

## Architecture and Domain Requirements

The design sources define the following requirements for the implementation:

- **Money representation:** persist amounts in minor currency units using PostgreSQL `BIGINT`; avoid JavaScript floating-point arithmetic for financial values.
- **Wallet integrity:** one wallet per player and currency, with a non-negative balance enforced by the database.
- **Wager transaction lifecycle:** support `BET`, `WIN`, `LOSS`, `REFUND`, and `ROLLBACK`, with `OPENING` reserved for internal wallet initialization.
- **Persistent idempotency:** identify requests using an idempotency key and a canonical payload hash.
- **Auditable ledger:** record financial movements with before/after balances and enforce append-only behavior.
- **Concurrency safety:** coordinate updates at wallet level and preserve invariants under concurrent requests.
- **Inbox and Transactional Outbox:** deduplicate consumed messages and publish integration events only after the database transaction commits.
- **Resilient asynchronous processing:** support retry, redelivery, and dead-letter handling.
- **Reconciliation:** compare the stored wallet balance with the balance reconstructed from ledger entries; report discrepancies rather than silently correcting them.

These are design requirements, not claims that every capability is already implemented.

## Progress and Verification

The following items have been reported as verified in the local development environment. The current `main` branch has not yet been synchronized with all of this work, so check the code and commit history before assuming each item is present in this published revision.

| Area | Current evidence | Status |
|---|---|---|
| NestJS baseline | `GET /` returned `HTTP 200 OK` with `Hello World!` | Verified locally |
| PostgreSQL | Docker Compose container reported healthy; `pg_isready` succeeded | Verified locally |
| MikroORM | `mikro-orm debug` reported a successful database connection | Verified locally |
| Initial `wallets` migration | Migration compiled, was applied, and `migration:pending` reported no pending migrations | Verified locally |
| Wallet schema constraints | Database rejected a negative balance and a duplicate player/currency pair | Verified locally |
| `Money` value object and unit tests | Implementation and test results not yet confirmed | Pending |
| Wager transactions, ledger, persistent idempotency, Inbox/Outbox, and SQS | Full implementation and integration evidence not yet confirmed | Pending |
| Concurrency and multi-instance scenarios | Automated results not yet confirmed | Pending |

The test commands below are available in the project configuration. They should be reported as passing only after they have actually been run and their results reviewed.

## Getting Started

### Prerequisites

- Bun (version compatible with the project lockfile)
- PostgreSQL for database-backed development
- Docker Compose if using the local database infrastructure

### Install dependencies

```bash
bun install
```

### Run the application

```bash
bun run start:dev
```

The current baseline exposes the default NestJS root endpoint:

```http
GET /
```

Database-backed features depend on the local environment and configuration being set up first. Do not commit the local `.env` file or real credentials.

## Quality Checks

The following scripts are defined in `package.json`:

```bash
# Build
bun run build

# Lint
bun run lint

# Unit tests
bun run test

# End-to-end tests
bun run test:e2e

# Coverage
bun run test:cov
```

A configured script is not, by itself, evidence that the corresponding checks pass. Results will be documented as implementation progresses.

## Development Roadmap

1. Complete and test the monetary value object and domain model.
2. Extend the database schema with wagering transactions and immutable ledger entries.
3. Implement transactional wallet operations and persistent idempotency.
4. Add reference validation and safe refund/rollback processing.
5. Implement Inbox/Outbox persistence and SQS integration.
6. Add retry, dead-letter, and recovery behavior.
7. Validate concurrency, redelivery, restart recovery, and wallet-to-ledger reconciliation.
8. Keep this README and the technical design documents aligned with the code and observed test evidence.

## Design Documentation

The architecture, database design, domain rules, messaging/outbox behavior, and test strategy are maintained as project design sources. As the implementation stabilizes, the corresponding documents and links will be added to the repository using their final tracked filenames.

## License

No open-source license has been selected yet.
