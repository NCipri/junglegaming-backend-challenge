# Distributed Wagering Processor

[Português](README.md) · **English**

A financial wagering service: wallets with an auditable ledger, `BET`, `WIN`, `LOSS`, `REFUND` and `ROLLBACK` transactions received over **HTTP** and **SQS**, persistent idempotency, transactional inbox/outbox, and correct processing with **multiple instances**.

- Stack: Bun 1.4.4 · strict TypeScript · NestJS 12 · PostgreSQL 17 · MikroORM 7 · SQS (MiniStack) · Keycloak · pino · Prometheus.
- Decisions, trade-offs and limitations: [`ARCHITECTURE.en.md`](ARCHITECTURE.en.md).

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Run the full stack](#2-run-the-full-stack)
3. [Authentication](#3-authentication)
4. [Using the API](#4-using-the-api)
5. [Using the SQS queue](#5-using-the-sqs-queue)
6. [HTTP status codes](#6-http-status-codes)
7. [Observability and operations](#7-observability-and-operations)
8. [Running the application outside Docker](#8-running-the-application-outside-docker)
9. [Tests](#9-tests)
10. [Challenge requirements → tests that prove them](#10-challenge-requirements--tests-that-prove-them)
11. [Commands](#11-commands)
12. [Project layout](#12-project-layout)

---

## 1. Prerequisites

- **Docker** with Docker Compose v2.
- **Bun 1.4.4** (`curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4`) — needed for the tests, the scripts and to obtain tokens.
- Free host ports: `8080` (API through nginx), `8081` (Keycloak), `55432` (PostgreSQL), `4566` (SQS), `9090` (Prometheus), `3001` (Grafana).

```bash
bun install
```

---

## 2. Run the full stack

```bash
docker compose up -d --build --wait
curl -s localhost:8080/health/ready    # {"status":"up","checks":{"database":"up","sqs":"up","shuttingDown":false}}
```

Compose starts, in this order:

| Service                   | What it does                                                                                                  | Host port |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | --------- |
| `postgres`                | PostgreSQL 17 (databases `wagering` and `keycloak`; roles `migrator` and `app`)                               | `55432`   |
| `ministack`               | SQS emulator                                                                                                  | `4566`    |
| `migrator`                | Applies the migrations as the `migrator` role and exits                                                       | —         |
| `sqs-init`                | Creates the FIFO queues (`wager-transactions`, its DLQ with `maxReceiveCount = 8`, `wallet-events`) and exits | —         |
| `keycloak`                | Identity provider with the `wagering` realm imported                                                          | `8081`    |
| `app-1`, `app-2`, `app-3` | Three application instances, each running **every role**: API, SQS consumer, outbox relay and pending worker  | —         |
| `nginx`                   | Single API entry point, round-robin across the three instances                                                | `8080`    |
| `prometheus`              | Scrapes the three instances' metrics every 5 s                                                                | `9090`    |
| `grafana`                 | Ready-made dashboard ("Wagering processor"), anonymous read access                                            | `3001`    |

Every response carries `X-Instance-Id` (which instance answered) and `X-Correlation-Id`:

```bash
for i in 1 2 3; do curl -s -D - -o /dev/null localhost:8080/health/live | grep -i x-instance-id; done
```

To stop: `docker compose down` (keeps the data) or `docker compose down -v` (deletes the PostgreSQL volume).

---

## 3. Authentication

JWTs issued by Keycloak (`client_credentials` flow), validated by the API through JWKS (signature, `iss`, `aud` and `exp`).

| Client                     | Role       | May                                                                   |
| -------------------------- | ---------- | --------------------------------------------------------------------- |
| `provider-a`, `provider-b` | `provider` | `POST /wagering/transactions`; read **their own** transactions        |
| `backoffice`               | `operator` | create and read wallets, ledger, reconciliation; read any transaction |

```bash
export OP=$(bun scripts/auth-token.ts backoffice)
export PA=$(bun scripts/auth-token.ts provider-a)
```

> The client secrets (`<client>-secret`) are fixed in the versioned realm for **local** use only. In any other environment they must come from a secret store.

The provider identity comes from the token (`azp`). A different `providerId` in the body or in the path is refused with **403 `PROVIDER_IDENTITY_MISMATCH`** and nothing is stored. Health endpoints and `/docs-json` are public.

---

## 4. Using the API

The OpenAPI 3.1 contract is served at `GET /docs-json`. `curl` examples (after exporting `OP` and `PA`):

**Create a wallet** (operator). An initial balance > 0 creates an internal `OPENING` transaction with a `CREDIT` ledger entry, in the same SQL transaction.

```bash
export PLAYER=$(bun -e 'console.log(Bun.randomUUIDv7())')
curl -s -X POST localhost:8080/wallets \
  -H "authorization: Bearer $OP" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"
# 201 {"id":"...","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
export WALLET=<id from the response>
```

**Submit a bet** (provider). The `Idempotency-Key` header is required.

```bash
curl -s -X POST localhost:8080/wagering/transactions \
  -H "authorization: Bearer $PA" -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# 200 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

- Repeating **the same** request → `200` with the **same** result and `"idempotentReplay": true`.
- Same key with a different payload → `409 IDEMPOTENCY_CONFLICT`.
- Same `externalTransactionId` with another key → `409 EXTERNAL_TRANSACTION_ID_CONFLICT`.
- Insufficient balance → `422` with `"status":"REJECTED","failureCode":"INSUFFICIENT_BALANCE"` (the rejection is stored).
- `ROLLBACK`/`REFUND` whose reference has not arrived yet → `202` with `"status":"PENDING_REFERENCE"`; the worker resolves it when the reference arrives.

**Queries**

```bash
curl -s localhost:8080/wallets/$WALLET -H "authorization: Bearer $OP"
curl -s "localhost:8080/wallets/$WALLET/ledger?limit=50" -H "authorization: Bearer $OP"   # newest first; follow nextCursor
curl -s localhost:8080/wagering/transactions/<transactionId> -H "authorization: Bearer $PA"
curl -s localhost:8080/providers/provider-a/wagering/transactions/tx-1 -H "authorization: Bearer $PA"
```

**Reconciliation** (operator) — compares the stored balance with the balance rebuilt from the ledger, in a single snapshot query. A divergence is logged, counted in a metric and flagged; it is **never** corrected automatically.

```bash
curl -s -X POST localhost:8080/wallets/$WALLET/reconciliation -H "authorization: Bearer $OP"
# {"walletId":"...","storedBalance":{...},"calculatedBalance":{...},"difference":{"amount":"0.00",...},"consistent":true,"checkedEntries":2,"chainIntact":true,"firstBrokenVersion":null}
```

**Health** (no authentication): `GET /health/live` (process alive) and `GET /health/ready` (PostgreSQL and SQS reachable; `503` while shutting down).

### Input rules

- Money is always `{"amount": "<string>", "currency": "<ISO-4217>"}` with **exactly two decimals** (`"25.00"`). A JSON number, a comma, a scale other than 2 or a lowercase currency → `400` with a specific code.
- `BET`, `REFUND` and the initial balance require an amount > 0. `WIN`, `LOSS` and `ROLLBACK` accept `"0.00"` (no balance effect).
- `walletId`/`playerId` are UUIDs; `providerId`, `externalTransactionId`, `roundId`, `gameId` and `referenceExternalTransactionId` are 1–120 printable ASCII characters; `providerId = "internal"` is reserved.
- `Idempotency-Key`: 1–255 printable ASCII characters, no surrounding spaces. Recommended: `"{providerId}:{externalTransactionId}"`.
- Unknown fields are refused. `application/json` bodies only, up to 64 KB.

---

## 5. Using the SQS queue

Each instance's consumer reads `wager-transactions.fifo` and uses **the same use case** as the API. Message:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "...",
    "walletId": "...",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Publish a test message:

```bash
bun run publish:wager "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"sqs-1\",\"idempotencyKey\":\"provider-a:sqs-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"g\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
```

| Situation                                                             | What the consumer does                                                                                                                                          |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Processed, rejected by a business rule, or replay                     | stores it, commits and **only then** deletes the message (ack)                                                                                                  |
| Already processed (same `messageId`)                                  | recognised by the persistent inbox and deleted, with no effect                                                                                                  |
| Transient error (database or network)                                 | does not delete; returns it with backoff `15 s, 30 s, 60 s … 300 s`; after 8 deliveries SQS moves it to the DLQ — **no `FAILED` is stored**, so a redrive works |
| Invalid payload, unknown type, idempotency or inbox conflict          | sends it to the DLQ (with a new `MessageDeduplicationId`) and deletes it                                                                                        |
| Unexpected deterministic error (e.g. a balance above `NUMERIC(19,2)`) | stores `FAILED (UNEXPECTED_PROCESSING_ERROR)` with its event and sends it to the DLQ                                                                            |

**Recommendation to producers:** `MessageGroupId = walletId` and `MessageDeduplicationId = messageId`. Correctness does **not** depend on it: idempotency and invariants live in PostgreSQL (there is a test with a _standard_ queue).

**DLQ redrive** (after fixing the cause):

```bash
bun run dlq:redrive     # receive → send to the source queue (new MessageDeduplicationId, same group) → delete
```

MiniStack does not support `StartMessageMoveTask`, hence the script. The inbox deduplicates by the body `messageId`, so reprocessing is safe.

**Published events** (`wallet-events.fifo`, `MessageGroupId = walletId`): `WagerTransactionProcessed`, `WalletBalanceChanged`, `WagerTransactionRejected`, `WagerTransactionPendingReference` and `WagerTransactionFailed`. Delivery is **at least once**: consumers must deduplicate by `eventId` and apply balances by `walletVersion`.

---

## 6. HTTP status codes

One table for every endpoint. Errors follow RFC 9457 (`application/problem+json` with `type`, `title`, `status`, `code`, `detail`, `correlationId`).

| HTTP | Meaning                                                                                                                                                                     | Retry?                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 200  | processed, replay or read                                                                                                                                                   | —                                     |
| 201  | wallet created                                                                                                                                                              | —                                     |
| 202  | accepted, waiting for its reference (`PENDING_REFERENCE`)                                                                                                                   | safe, no effect                       |
| 400  | invalid payload: `INVALID_PAYLOAD`, `INVALID_AMOUNT_FORMAT`, `INVALID_AMOUNT_SCALE`, `INVALID_AMOUNT_ZERO`, `INVALID_CURRENCY`, `IDEMPOTENCY_KEY_MISSING`, `INVALID_CURSOR` | no, fix the payload                   |
| 401  | `UNAUTHENTICATED` (missing, invalid or expired token)                                                                                                                       | after renewing the token              |
| 403  | `FORBIDDEN` (role without access) or `PROVIDER_IDENTITY_MISMATCH`                                                                                                           | no                                    |
| 404  | `NOT_FOUND` (including another provider's transaction)                                                                                                                      | no                                    |
| 409  | `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `WALLET_ALREADY_EXISTS`                                                                                         | no                                    |
| 422  | business rejection (`status: REJECTED` + `failureCode`) or deterministic error (`status: FAILED`)                                                                           | no — a resend returns the same result |
| 503  | transient infrastructure failure (`SERVICE_UNAVAILABLE`), with `Retry-After`                                                                                                | **yes**, with the same key            |
| 500  | unexpected error outside transaction processing (`INTERNAL_ERROR`)                                                                                                          | safe                                  |

The possible `failureCode` values are listed in [`ARCHITECTURE.en.md`](ARCHITECTURE.en.md#9-failure-taxonomy).

---

## 7. Observability and operations

- **Logs**: JSON (pino) with `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, kind, status, `failureCode` and duration. Amounts, balances, `playerId`, tokens and bodies are **never** logged (automatic redaction).

  ```bash
  docker compose logs -f app-1
  ```

- **Prometheus metrics** at `/metrics` on an **internal** port (`9464`), separate from the API and not published on the host:

  ```bash
  docker compose exec app-1 bun -e "console.log(await (await fetch('http://127.0.0.1:9464/metrics')).text())"
  ```

  Main ones: `wager_transactions_total{status,kind}`, `idempotent_replays_total`, `idempotency_conflicts_total`, `inbox_duplicates_total`, `processing_retries_total{reason}`, `dlq_messages_total{reason}`, `dlq_depth`, `lock_conflicts_total`, `db_deadlocks_total`, `outbox_lag_seconds`, `processing_duration_seconds{channel}`, `wallet_lock_wait_seconds`, `db_transaction_duration_seconds`, `reconciliation_divergence_total`.

- **Dashboard:** open `http://localhost:3001` (Grafana, no login). The "Wagering processor" dashboard shows transactions by status and kind, duplicates and conflicts, p50/p95/p99 latency, wallet lock wait, retries, lock conflicts and deadlocks, DLQ, outbox lag, reconciliation divergences and instances up. Prometheus is at `http://localhost:9090`.
- **Reaching a specific instance:** instances do not publish ports; use `docker compose exec app-2 …` (as above) or look at `X-Instance-Id` in nginx responses.
- **nginx:** round-robin balancing. Open-source nginx does **not** query the readiness endpoint: an instance is taken out passively after connection failures (`max_fails=2`, `fail_timeout=10s`), and POSTs are not retried on another instance.
- **Shutdown (`SIGTERM`):** readiness switches to `503`; in parallel, the consumer finishes in-flight messages and in-flight HTTP requests finish (the listener keeps accepting while draining). An SQS message running past 20 s has its transaction cancelled (rollback) and goes back to the queue; then the listener and the pool close and the process exits with code 0, within the 30 s `stop_grace_period`.

---

## 8. Running the application outside Docker

```bash
docker compose up -d --wait postgres ministack keycloak
bun run migrate:up               # uses DATABASE_MIGRATOR_URL
bun run sqs:init
cp .env.example .env             # Bun loads .env automatically
bun run start                    # roles from APP_ROLES; API on :3000, metrics on :9464
```

`APP_ROLES` accepts any combination of `api`, `sqs-consumer`, `outbox-relay` and `pending-reference-worker`. Every variable (timeouts, pool, backoff, pending TTL) is validated at startup; see `src/config/config.schema.ts`.

---

## 9. Tests

Integration and concurrency tests start **real PostgreSQL and MiniStack** containers (Testcontainers) — Docker must be running. No database or queue is simulated.

```bash
bun run test:unit            # domain, rules, Money, error classification (no Docker)
bun run test:integration     # database, repositories, use cases, HTTP, SQS, outbox, worker, Keycloak, logs and metrics
bun run test:concurrency     # real parallelism; includes the suite with 3 Bun application processes
bun run test:coverage        # unit + integration with gates: src ≥ 90%, domain ≥ 95%, every file ≥ 80%
REPEAT=20 bun test tests/concurrency/multi-process -t "README scenario (1|2|5) "   # repeats the critical scenarios
```

At the end of every integration and concurrency test, an assertion checks **every** wallet: balance = ledger sum, contiguous version chain, every balance-moving `PROCESSED` transaction has exactly one entry.

---

## 10. Challenge requirements → tests that prove them

### Mandatory tests

| Requirement                                                        | Where                                                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Money` operations and validation (scale, rounding, invalid input) | `tests/unit/shared/money.test.ts`, `money.property.test.ts`                                                                                                         |
| `Wallet` invariants                                                | `tests/unit/wallet/wallet.test.ts`, `wallet-ledger-entry.test.ts`                                                                                                   |
| `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` rules                   | `tests/unit/wagering/wager-rules.test.ts`, `wager-transaction.test.ts`                                                                                              |
| Currency conflict                                                  | `wager-rules.test.ts` (`CURRENCY_MISMATCH`), `money.test.ts`                                                                                                        |
| Idempotency key with a diverging payload                           | `tests/unit/wagering/wager-transaction.test.ts` (`matchesPayload`), `tests/integration/use-cases/process-wager.test.ts`, `tests/integration/http/api.test.ts` (409) |
| Migrations and constraints                                         | `tests/integration/db/migrations.test.ts`, `constraints.test.ts`, `privileges.test.ts`                                                                              |
| Atomicity across wallet, ledger, inbox and outbox                  | `tests/integration/use-cases/atomicity-and-reconcile.test.ts`, `persistence/write-order.test.ts`                                                                    |
| Inbox and redelivery                                               | `tests/integration/messaging/sqs-consumer.test.ts`                                                                                                                  |
| Concurrent publishers on the same outbox                           | `outbox-relay.test.ts` (two relays, 200 events), `multi-process/cluster-scenarios.test.ts` (scenarios 4 and 6)                                                      |
| Retry and DLQ                                                      | `sqs-consumer.test.ts` (backoff, exhaustion, DLQ, redrive)                                                                                                          |
| Recovery after restart                                             | `multi-process/crash-and-restart.test.ts` (scenario 8)                                                                                                              |
| 1. The same bet 50× in parallel → a single debit                   | `concurrency/use-case/same-bet-50x.test.ts`; with 3 processes, over HTTP and SQS: `cluster-scenarios.test.ts` (scenario 1)                                          |
| 2. Two bets of 80 on a balance of 100                              | `concurrency/use-case/two-bets-80.test.ts`; `cluster-scenarios.test.ts` (scenario 2)                                                                                |
| 3. Distinct wallets in parallel                                    | `concurrency/use-case/distinct-wallets.test.ts`; `cluster-scenarios.test.ts` (scenario 3)                                                                           |
| 4. ≥ 3 simultaneous processes                                      | the whole `tests/concurrency/multi-process/` folder (3 real Bun processes)                                                                                          |
| 5. Worker killed after commit and before ack                       | `crash-and-restart.test.ts` (scenario 5, real `SIGKILL`) and `sqs-consumer.test.ts`                                                                                 |
| 6. Two publishers on the same outbox                               | `outbox-relay.test.ts`; `cluster-scenarios.test.ts` (scenario 6)                                                                                                    |
| 7. `ROLLBACK`/`REFUND` before its reference                        | `tests/integration/wagering/pending-reference.test.ts`; `cluster-scenarios.test.ts` (scenario 7)                                                                    |
| 8. Restart with final consistency                                  | `crash-and-restart.test.ts` (scenario 8, `kill -9` on all 3 instances)                                                                                              |
| Final invariant `wallet.balance == ledger`                         | `tests/support/invariants.ts`, called at the end of every integration and concurrency test                                                                          |

### Hard constraints

| Constraint                                  | How it is guaranteed                                                                                         | Test                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| No `number` for money                       | `Money` on `decimal.js`, `NUMERIC(19,2)` columns read as strings; a lint rule forbids conversions            | `money.test.ts`, `persistence/money-roundtrip.test.ts`, `tooling/lint-rules.test.ts`, `api.test.ts` (no numbers in responses) |
| Idempotency is not an in-memory cache       | `UNIQUE (provider_id, idempotency_key)` and the inbox in PostgreSQL                                          | `constraints.test.ts`, `same-bet-50x.test.ts`, `cluster-scenarios.test.ts`                                                    |
| Do not rely on SQS FIFO alone               | the guarantees live in the database                                                                          | `cluster-scenarios.test.ts` (_standard_ queue with duplicates)                                                                |
| No event before commit                      | outbox in the same transaction; the relay only reads committed rows                                          | `outbox-relay.test.ts` (an open transaction is invisible)                                                                     |
| Ledger never overwritten nor deleted        | trigger refusing `UPDATE`/`DELETE` + the `app` role lacks those privileges                                   | `constraints.test.ts`, `privileges.test.ts`                                                                                   |
| No global lock                              | pessimistic lock **per wallet**                                                                              | `distinct-wallets.test.ts` (parallel faster than sequential)                                                                  |
| No uncontrolled `read → calculate → update` | `SELECT … FOR UPDATE` + `UPDATE … WHERE version = ?` + `UNIQUE (wallet_id, wallet_version)`                  | `persistence/runner.test.ts`, `two-bets-80.test.ts`                                                                           |
| Correct with multiple instances             | all of the above, in the database                                                                            | `tests/concurrency/multi-process/*`                                                                                           |
| Guarantees in the schema                    | `CHECK`, `UNIQUE`, FKs, partial indexes, triggers and commit-time constraint triggers (balance = last entry) | `constraints.test.ts`                                                                                                         |

---

## 11. Commands

| Command                                                                         | What it does                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `bun run start`                                                                 | starts the application with the `APP_ROLES` roles |
| `bun run migrate:up` / `bun run migrate:down [n]`                               | applies / reverts `n` migrations (default 1)      |
| `bun run sqs:init`                                                              | creates the queues (idempotent)                   |
| `bun run publish:wager '<data JSON>'`                                           | publishes a `WagerTransactionRequested`           |
| `bun run dlq:redrive`                                                           | moves the DLQ messages back to the input queue    |
| `bun run auth:token <client>`                                                   | prints a Keycloak access token                    |
| `bun run lint` / `typecheck` / `format:check`                                   | code quality                                      |
| `bun run test:unit` / `test:integration` / `test:concurrency` / `test:coverage` | tests                                             |

**Pre-commit** (lint, typecheck and unit tests): `git config core.hooksPath .githooks`.

CI (`.github/workflows/ci.yml`) runs lint, formatting, typecheck, unit tests, integration with coverage, and the concurrency suite with `REPEAT=20` on the critical scenarios.

---

## 12. Project layout

```
src/
  main.ts · app.module.ts · http-app.ts      role-based bootstrap and composition
  config/                                    validated environment (Zod)
  shared/                                    Money, canonical hash, clock, ids, backoff
  modules/
    wallet/      domain · application · infrastructure · interface
    wagering/    domain (rules, states) · application (use cases, worker) · infrastructure · interface (HTTP, SQS message)
    messaging/   domain (inbox, outbox, events) · infrastructure (SQS, relay, consumer, redrive)
    identity/    JWT/JWKS, guard, roles
    observability/ · health/
  infrastructure/
    db/          MikroORM, migrations, WalletTransactionRunner, error classification
    http/        problem details, validation, correlation, OpenAPI
    fault/       fault injection for the crash tests
tests/  unit · integration · concurrency · support
docker/ postgres · keycloak · nginx
scripts/ migrate · sqs-init · dlq-redrive · publish-wager-message · auth-token · coverage-check
```
