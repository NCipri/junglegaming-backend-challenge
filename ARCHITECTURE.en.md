# Architecture

[Português](ARCHITECTURE.md) · **English**

This document explains **how** the service guarantees financial correctness and **why** each choice was made, with the alternatives considered, the trade-offs and the limitations. Setup and usage are in [`README.en.md`](README.en.md).

## Contents

1. [Principles](#1-principles)
2. [Overview](#2-overview)
3. [Domain model](#3-domain-model)
4. [Persistence: ORM, `Money` and transactional strategy](#4-persistence-orm-money-and-transactional-strategy)
5. [Processing flow of a transaction](#5-processing-flow-of-a-transaction)
6. [Concurrency](#6-concurrency)
7. [Idempotency](#7-idempotency)
8. [Messaging: inbox, outbox, consumer, DLQ](#8-messaging-inbox-outbox-consumer-dlq)
9. [Failure taxonomy](#9-failure-taxonomy)
10. [Out-of-order references](#10-out-of-order-references)
11. [HTTP API and authentication](#11-http-api-and-authentication)
12. [Business-rule interpretations](#12-business-rule-interpretations)
13. [Observability](#13-observability)
14. [Testing strategy](#14-testing-strategy)
15. [Known limitations and trade-offs](#15-known-limitations-and-trade-offs)
16. [Evaluated and not implemented](#16-evaluated-and-not-implemented)

---

## 1. Principles

1. **The database is the source of truth for invariants.** Every uniqueness, immutability and non-negativity guarantee exists in the schema (`CHECK`, `UNIQUE`, FKs, partial indexes, triggers and privileges), not only in code. The application may have bugs; PostgreSQL refuses the invalid state.
2. **Financial correctness does not depend on availability.** Deadlocks, timeouts, SQS outages and process crashes affect latency, never balances: everything is transactional and idempotent, and whatever fails is retried safely.
3. **Determinism.** The same request always yields the same response; replays are built only from stored data.
4. **Justified simplicity.** Every extra mechanism exists to meet a requirement; whatever is not required and adds risk was evaluated and documented, not implemented.

---

## 2. Overview

A **hexagonal modular monolith** in NestJS on Bun. The domain is plain TypeScript (no NestJS or MikroORM — enforced by a lint rule); use cases orchestrate; adapters (HTTP, SQS, PostgreSQL) sit at the edges.

```
                 ┌──────────────┐    HTTP (JWT)      ┌──────────────────────────────────────────────┐
  providers  ───▶│    nginx     │──round-robin──────▶│ app-1 / app-2 / app-3 (same image)           │
  operator   ───▶│    :8080     │                    │  roles: api · sqs-consumer · outbox-relay ·  │
                 └──────────────┘                    │         pending-reference-worker             │
                                                     └──────┬──────────────┬──────────────┬─────────┘
  wager-transactions.fifo ──────(consumer)──────────────────┘              │              │
  wager-transactions-dlq.fifo ◀─(permanent / exhausted)                    │              │
                                                                   PostgreSQL 17     wallet-events.fifo
                                                         (wallets, ledger, transactions,  ◀──(relay)
                                                          inbox, outbox, providers)
```

- **One image, several roles** (`APP_ROLES`). In Compose, the 3 instances run every role; each role works with N instances because all coordination goes through the database (row locks, leases, `SKIP LOCKED`, constraints).
- **Modules:** `wallet`, `wagering`, `messaging`, `identity`, `observability`, `health`, plus `shared` (Money, canonical hash, clock, ids, backoff) and `infrastructure` (database, HTTP, fault injection).
- **A single place opens transactions and locks wallets:** `WalletTransactionRunner`. Use cases never call `FOR UPDATE` directly.

---

## 3. Domain model

Invariants live **inside the classes**, with private state and explicit transitions.

### `Money`

- `decimal.js` with ample precision; **fixed scale 2**; immutable; never rounds.
- Input only as a string matching `^(0|[1-9]\d{0,16})\.\d{2}$` (fits `NUMERIC(19,2)`). A JSON number, `"25.5"`, `"25,00"`, `"1e3"`, `"-1.00"`, `"NaN"` are refused with distinct codes (`INVALID_AMOUNT_FORMAT`, `INVALID_AMOUNT_SCALE`).
- Operations across currencies throw `CurrencyMismatchError`. Serialises as `{ "amount": "25.00", "currency": "BRL" }` — never a number.
- Property-based tests (fast-check) for commutativity, round-trips and format.

### `Wallet` (aggregate root)

- Balance and version change only through `debit()`/`credit()`, which return the matching `WalletLedgerEntry` (`balanceBefore ± amount = balanceAfter`, `walletVersion` = new version). A debit that would make the balance negative is refused.
- `Wallet.open()` with a balance > 0 requires the opening transaction and creates the `CREDIT` entry at version 1.

### `WagerTransaction` (state machine)

```
           ┌──────────────▶ PROCESSED
 PENDING ──┼──────────────▶ REJECTED (failureCode)
 (memory)  ├──────────────▶ FAILED (UNEXPECTED_PROCESSING_ERROR)
           └─▶ PENDING_REFERENCE ──▶ PROCESSED | REJECTED   (worker only)
```

- `PENDING` exists only in memory: the row is **born in its final state** (the status `CHECK` does not even accept `PENDING`).
- `PROCESSED`, `REJECTED` and `FAILED` are terminal — also enforced by a trigger, which additionally refuses changes to immutable columns (provider, ids, key, hash, wallet, player, round, game, kind, amount, currency).
- Transactions and wallets are **never deleted** (trigger, even for the schema owner), and a wallet's identity (`id`, `player_id`, `currency`, `created_at`) is immutable.

### `WalletLedgerEntry`

Immutable (frozen at runtime), `amount > 0`, arithmetic checked by the factory and by a `CHECK` in the database. The ledger is **chained** by `wallet_version`: `UNIQUE (wallet_id, wallet_version)`, and each entry starts where the previous one ended — reconciliation detects any break.

**Balance and ledger tied in the database:** `DEFERRABLE INITIALLY DEFERRED` constraint triggers check at `COMMIT` that the balance and version of every changed wallet equal the last entry's `balance_after` and `wallet_version` (or `0.00` at version 1 with no entries). A bug changing the balance without an entry — or the other way round — is refused at commit and the transaction becomes `FAILED`, with no partial state (also tested by mutation: with the entry INSERT removed, the bet becomes `FAILED` and the balance stays intact).

### `InboxMessage`, `OutboxMessage` and integration events

Classes with static `eventType`/`version` (no loose strings); frozen payload; outbox backoff by the single formula `min(base × 2^n × jitter[0.8, 1.2], cap)`.

---

## 4. Persistence: ORM, `Money` and transactional strategy

### Why MikroORM (v7)

It is the challenge's preferred ORM and offers `em.transactional()`, `LockMode` and control over explicit SQL. It was validated in a proof of concept on Bun before starting (programmatic migrations, `NUMERIC` as string, `FOR UPDATE` inside a transaction).

### How it is used — and why not through the Unit of Work

- **Records + mappers:** the domain does not know the ORM. Each table has a _record_ (`EntitySchema`) and a mapper that always rebuilds the domain through `rehydrate` (tested with spies).
- **Explicit SQL on the transactional path:** writes via `em.insert`/`em.nativeUpdate` and reads via SQL with an explicit column list. **Never** `persist`/`flush`.
  - `flush` reorders INSERTs and UPDATEs on its own and could insert a ledger entry before the transaction it references (FK violation); a test checks the actual order of statements.
  - The _identity map_ would return a wallet's stale state after a `nativeUpdate` in the same transaction.
  - The version check is explicit (`UPDATE … WHERE id = ? AND version = ?`, 0 rows ⇒ conflict) instead of the ORM's `version: true`.

### `Money` mapping

`NUMERIC(19,2)` columns + a `CHAR(3)` currency with a `CHECK`. The `pg` driver returns `NUMERIC` as a string; records type those columns as `string`, and the mapper calls `Money.from` — money never goes through `number` in any layer (there is a round-trip test with `"99999999999999999.99"`). A `NUMERIC(19,2)` overflow is detected by the database (`22003`) and treated as a deterministic error.

### Transactional strategy (`WalletTransactionRunner`)

- `READ COMMITTED` + pessimistic lock per wallet (section 6).
- Right after `BEGIN`: `lock_timeout = 5s`, `statement_timeout = 10s`, `idle_in_transaction_session_timeout = 30s` (transaction-local).
- Retries by **error class**: transient → up to 3 attempts with jitter; uniqueness violation → rollback and re-run of the whole unit (up to 2 times); deterministic → thrown at once.
- Cancellation through an `AbortSignal` (kills the database session ⇒ rollback), used during shutdown.
- Client timeouts: connection and pool 5 s, query 15 s, SQS 5 s/10 s (long polling uses wait + 5 s, per request) — with the database or SQS frozen, nothing hangs (tested with a paused Postgres: 503 in under 20 s).

### Database roles (least privilege)

- `migrator`: schema owner; only runs migrations.
- `app`: runtime. `SELECT` on `providers`; `SELECT, INSERT` on the ledger (**no** `UPDATE`/`DELETE`); `SELECT, INSERT, UPDATE` on the rest. Tested.

### Migrations

Hand-written SQL, reversible (`up`/`down`), run by a programmatic script. Tests: `up → down → up`, reverting one step at a time.

---

## 5. Processing flow of a transaction

The **same use case** (`ProcessWagerTransaction`) serves HTTP and SQS; the core that decides and writes (`WagerProcessor`) is reused by the pending-reference worker.

**Before the transaction:** validates the payload (400 / DLQ) and computes the `payloadHash`.

**Per-channel order:**

- **HTTP:** lock-free read by key → if found, answers the replay without opening a transaction.
- **SQS:** `BEGIN` → INSERT into the inbox (duplicate ⇒ ack with no effect) → read by key → if found, replay.

**Inside the transaction — fixed write order:**

1. locks the wallet (`SELECT … FOR UPDATE`, if it exists) and **re-reads the key under the lock** (race ⇒ replay);
2. external id already used with another key ⇒ `EXTERNAL_TRANSACTION_ID_CONFLICT`;
3. decides in memory (`decideWager`: rules in a fixed order, the first violation wins);
4. `UPDATE wallets … WHERE version = ?` (only when the balance changes);
5. `INSERT` of the transaction **already in its final state**, with the observed balance;
6. `INSERT` of the ledger entry (only when the balance changes);
7. speeds up pending transactions waiting for this one;
8. `INSERT` of the events into the outbox;
9. (SQS) marks the inbox; `COMMIT`; only then `DeleteMessage`.

Any error before commit undoes **everything** together: balance, transaction, ledger, inbox and outbox (tested by injecting a failure after the ledger insert and right before commit).

---

## 6. Concurrency

**Unit of concurrency: the wallet.**

### Chosen strategy: pessimistic lock per wallet, with extra barriers

- `SELECT … FOR UPDATE` on the wallet row, in `READ COMMITTED`.
- Barriers independent of the lock: `UPDATE … WHERE version = ?`, `UNIQUE (wallet_id, wallet_version)` on the ledger and `CHECK (balance >= 0)`.

| Alternative                                             | Why not                                                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Optimistic locking with retry                           | on a contended wallet (50 parallel requests, the mandatory scenario) it becomes a retry storm and can exhaust the limit |
| `UPDATE … SET balance = balance - x WHERE balance >= x` | does not naturally return `balanceBefore` for the ledger and bypasses the aggregate                                     |
| Global lock / single queue                              | forbidden, and kills parallelism across wallets                                                                         |

Different wallets run in parallel (test: 20 wallets × 10 bets in parallel is faster than sequentially). Accepted limitation: **a wallet processes one operation at a time**.

### Deadlock prevention: a global lock order

`① inbox → ② wallet → ③ transactions → ④ ledger → ⑤ outbox` — every transaction follows this order, may skip steps, never goes back; each transaction locks **at most one** wallet; multiple rows of the same type always in id order; references are not locked (they belong to the same, already locked wallet); pending and outbox claims use `SKIP LOCKED`; reconciliation takes no locks.

**Honest scope:** this makes deadlocks impossible _among the inventoried paths, as long as the rule is followed_. Future code may break it; hence the verification (chaos tests with 3 processes measure a `pg_stat_database.deadlocks` delta of 0) and the recovery (a deadlock is transient: full rollback and retry). **Financial correctness does not depend on the absence of deadlocks — only latency does.**

### Error classification: infrastructure is transient by default

- **Transient:** deadlock, lock timeout, serialisation failure, `statement_timeout`, connection, server restarting, pool exhausted, network, version conflict. ⇒ retry; once exhausted, `503` (HTTP) or the message is returned with backoff (SQS).
- **Uniqueness violation:** rollback and re-run; on the way back the fast path finds the row ⇒ replay or 409.
- **Deterministic (closed list):** unexpected domain error, invalid data (`22xxx`, e.g. overflow), integrity other than uniqueness (`23xxx`), trigger (`P0001`). ⇒ stores `FAILED` in a separate transaction and answers `422 FAILED` / sends to the DLQ.

Inverting the default (treating the unknown as permanent) would turn a `statement_timeout` or a restarting Postgres into a definitive `FAILED` — and a redrive could never process it again.

---

## 7. Idempotency

- **Key:** `Idempotency-Key`, unique **per provider** (`UNIQUE (provider_id, idempotency_key)`); also `UNIQUE (provider_id, external_transaction_id)`.
- **`payloadHash`** = SHA-256 of the canonical JSON (keys sorted recursively, no whitespace, nulls omitted) of `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`. The key and transport metadata are excluded.
- **Same key + same hash** ⇒ replay, with the response built only from stored data (including the **balance observed at that moment**). **Same key + different hash** ⇒ 409 without revealing the original.
- **HTTP and SQS share idempotency:** the same operation through both channels has a single effect (tested with 50 submissions, half through each channel, across 3 instances).
- **Every business rejection is stored**, so that a resend always yields the same result — `WALLET_NOT_FOUND` stays so even after the wallet is created.

---

## 8. Messaging: inbox, outbox, consumer, DLQ

### Inbox

`PK (consumer_name, message_id)` using the **body** `messageId` (survives a redrive). Inbox hash = SHA-256 of the canonical JSON of `type` + `data` (without `occurredAt`: a legitimate producer resend does not become a conflict). Inserted with `ON CONFLICT DO NOTHING` in the same transaction as the processing.

### SQS consumer

- 20 s long polling, batches of up to 10, different groups in parallel and messages of the same group sequentially; 30 s visibility with a heartbeat every 10 s.
- Action per error class: see the table in the [README](README.en.md#5-using-the-sqs-queue). Sending to the DLQ uses a **new `MessageDeduplicationId`** (FIFO would silently drop a repeated id within 5 minutes) and the same group, and only then deletes the original.
- Transient: `ChangeMessageVisibility(min(15 × 2^(delivery−1), 300) s)`; with `maxReceiveCount = 8`, ≈ 23 minutes of tolerance before the DLQ. No `FAILED` is stored on this path, so a redrive after the incident processes normally.

### Outbox

- Events stored **in the same transaction** as the effect; the relay only sees committed rows (tested with a transaction held open).
- Relay with a **lease** (`locked_until`/`locked_by`, 30 s) and `FOR UPDATE SKIP LOCKED`: several instances publish in parallel without taking the same event; if one dies after publishing and before marking, another republishes after the lease (same `eventId`, same bytes — the body is the stored `payload::text`, never re-serialised).
- The outbox **never gives up**: failure ⇒ retry with backoff (base 1 s, cap 300 s) and `last_error`; the delay shows in `outbox_lag_seconds`.
- **At-least-once** delivery; consumers deduplicate by `eventId`.

#### Event ordering — options evaluated

The challenge does not require ordering, but it is desirable for consumers of `WalletBalanceChanged`.

| Option                                                                                        | For                                                                           | Against                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Order by `occurred_at`                                                                        | simple                                                                        | uses each instance's clock: with 3 instances, two events of the same wallet may be swapped; an event in retry is overtaken                                                                              |
| **Strict per-wallet order** (the relay only publishes the first pending event of each wallet) | order guaranteed even under failure                                           | **head-of-line blocking:** an event SQS rejects forever freezes the whole wallet; a wallet with many events drains one per cycle; working around it needs more machinery (parking events, block claims) |
| **Commit order without blocking** (chosen)                                                    | commit order within each batch, clock-independent; no event holds others back | under failure, or with several relays publishing batches in parallel, an event may arrive after later ones                                                                                              |

**How it works:** every outbox row gets a `seq` (`GENERATED ALWAYS AS IDENTITY`) at INSERT time, which happens under the wallet lock — i.e. in commit order. The relay claims in `seq` order and publishes each wallet's events sequentially (different wallets in parallel); `MessageGroupId = walletId` preserves that order in FIFO. With several relays, different batches are published in parallel and two events of the same wallet in different batches may swap — ordering is therefore **best-effort**, and consumers apply balances by `walletVersion`.

**Why:** it meets everything the challenge requires without adding risks. Strict ordering was implemented, tested and **reverted**: it traded a rare problem the consumer already handles (an out-of-order event under failure — it deduplicates by `eventId` and applies balances by `walletVersion`) for two worse operational risks (a wallet stalled by a poison event; a large backlog draining slowly).

### Graceful shutdown — options evaluated

| Option                                                                                                                                                             | Against                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Sequential: stop the consumer, then close HTTP                                                                                                                     | readiness never answers 503 (goes straight to "connection refused") and the worst case adds both times |
| **Parallel** (chosen): readiness 503 → drain the consumer and HTTP requests at the same time, with the listener still accepting → close listener and pool → exit 0 | slightly more code (an in-flight request counter)                                                      |

An SQS message running past the 20 s deadline has its transaction **cancelled before** the message goes back to the queue (otherwise the transaction would keep holding the inbox row while another instance receives the message). Tested: the in-flight request gets 200, a new request during the drain is served, the process exits with 0.

---

## 9. Failure taxonomy

Every rejection carries a stable `failureCode`. "Fix" means sending a **new** transaction (new external id and new key): the original already has a stored terminal result, and resending it returns the same result.

| `failureCode`                 | Status   | When                                                                                                                     | Provider action                                  |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `INSUFFICIENT_BALANCE`        | REJECTED | `BET` without enough balance                                                                                             | give up                                          |
| `REVERSAL_WOULD_OVERDRAW`     | REJECTED | `ROLLBACK` of a `WIN`/`REFUND` would make the balance negative                                                           | escalate to operations                           |
| `CURRENCY_MISMATCH`           | REJECTED | currency differs from the wallet's                                                                                       | fix                                              |
| `WALLET_NOT_FOUND`            | REJECTED | wallet does not exist                                                                                                    | fix                                              |
| `PLAYER_WALLET_MISMATCH`      | REJECTED | `playerId` does not own the wallet (the balance is **not** revealed)                                                     | fix                                              |
| `UNKNOWN_PROVIDER`            | REJECTED | unknown or inactive provider                                                                                             | contact the operator                             |
| `REFERENCE_REQUIRED`          | REJECTED | `REFUND`/`ROLLBACK` without a reference                                                                                  | fix                                              |
| `REFERENCE_NOT_FOUND`         | REJECTED | the reference did not arrive in time                                                                                     | investigate                                      |
| `REFERENCE_MISMATCH`          | REJECTED | reference from another provider, player, wallet, currency or round                                                       | fix                                              |
| `INVALID_REFERENCE_KIND`      | REJECTED | `REFUND` of a non-`BET`; `ROLLBACK` of a `LOSS`/`ROLLBACK`; `WIN`/`LOSS` referencing a non-`BET`; `BET` with a reference | fix                                              |
| `REFERENCE_AMOUNT_MISMATCH`   | REJECTED | amount differs from the reference's (partial reversal is out of scope)                                                   | fix                                              |
| `REFERENCE_NOT_PROCESSED`     | REJECTED | the reference exists but was rejected or failed                                                                          | give up                                          |
| `ALREADY_REVERSED`            | REJECTED | the reference was already reversed; or a `WIN` of a reversed `BET`                                                       | give up                                          |
| `BET_ALREADY_SETTLED`         | REJECTED | reversal of a `BET` that has a processed, standing `WIN`                                                                 | `ROLLBACK` the `WIN` first                       |
| `OPENING_NOT_ALLOWED`         | REJECTED | `OPENING` sent through the API or the queue                                                                              | fix                                              |
| `UNEXPECTED_PROCESSING_ERROR` | FAILED   | a valid payload triggered an unexpected error; **nothing was applied**                                                   | do not resend the same key; contact the operator |

Insufficient balance on a bet and a reversal that would overdraw have **distinct** codes because they call for different actions (give up × escalate).

---

## 10. Out-of-order references

- Missing reference ⇒ the transaction is stored as `PENDING_REFERENCE` (with the observed balance), answers `202` and emits `WagerTransactionPendingReference`. **A resend never resolves a pending transaction** — it returns the `202` replay.
- **Worker** (on every instance): claims due pending rows with a 30 s lease (`SKIP LOCKED`) in a short transaction; resolves each in its own transaction through the **same core** as normal processing: locks the wallet → re-reads → **first tries to resolve** → if the reference is still missing and the deadline has passed, `REJECTED REFERENCE_NOT_FOUND` + event; otherwise, reschedules with backoff (base 1 s, cap 300 s).
- **Speed-up:** when the reference arrives, the pending transactions waiting for it have their next attempt moved to now — resolved in under 2 s in the test.
- **24 h TTL** (configurable): covers realistic provider delays and same-day queue reprocessing without leaving pending items forever. A reference that arrives after the deadline but before the worker runs still resolves the pending transaction (it tries to resolve before checking the deadline).
- Chains work: a `ROLLBACK` of a `REFUND` that waits for the `BET` — all three resolve in sequence.
- A deterministic error while resolving (e.g. the pending `WIN` would overflow `NUMERIC(19,2)`) stores `FAILED (UNEXPECTED_PROCESSING_ERROR)` with its event, in a separate transaction — the pending item does not retry forever.

---

## 11. HTTP API and authentication

- Status codes: one table for every endpoint (see the [README](README.en.md#6-http-status-codes)). It distinguishes invalid payload (400), idempotency conflict (409), business rejection (422 `REJECTED`), pending acceptance (202) and transient failure (503 + `Retry-After`) — the provider decides whether to resend without parsing messages.
- Validation with Zod, strict schemas (extra field = 400); the same schemas generate the OpenAPI document (`/docs-json`) and validate SQS messages.
- **Real authentication with Keycloak** (`client_credentials`), one client per provider and one for the operator. The guard is generic (OIDC via JWKS, `jose`): switching identity providers is configuration only. JWKS is cached: with Keycloak down, valid tokens keep being accepted; Keycloak is **not** part of readiness. Unreachable JWKS ⇒ 503 (the provider may resend) and a metric.
- **Access rules:** the provider identity comes from the token (`azp`); a diverging `providerId` ⇒ 403 and nothing stored; another provider's transaction fetched by id ⇒ 404 (does not reveal it exists). Providers **do not** read wallets or the ledger — a wallet is shared across providers; they see the balance only in the responses to their own transactions. The operator creates wallets.
- The SQS queue is a trusted internal channel, without tokens; the message `providerId` goes through the same validations.

---

## 12. Business-rule interpretations

| Topic                       | Interpretation                                                                                                                                         | Why                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Round                       | `roundId` is just an attribute; there is no lifecycle (open/closed). Several `BET`/`WIN` per round and a `WIN` after a `LOSS` are accepted             | the provider knows the game rules (free spins, jackpots, several bets per round); closing rounds would reject due payouts and break with out-of-order messages. The round is only used to validate references |
| `WIN`                       | reference is **optional**; when present it must be the `BET` of the same round, and it becomes pending if not there yet                                | the statement says a `WIN` "may" reference the `BET`                                                                                                                                                          |
| Reversals                   | a transaction is reversed **only once, by any kind** (`REFUND` or `ROLLBACK`) — a partial unique index in the database                                 | taken literally ("by the same kind") it would allow `BET -10 → REFUND +10 → ROLLBACK(BET) +10`: a double refund                                                                                               |
| Undone reversal             | a `ROLLBACK` of a `REFUND` is allowed (undoes the refund), but the `BET` stays marked as already reversed                                              | avoids reversal cycles; the unique index still holds                                                                                                                                                          |
| `WIN` of a reversed `BET`   | `ALREADY_REVERSED` (only a standing reversal counts)                                                                                                   | would pay the refund **and** the prize                                                                                                                                                                        |
| Reversal of a settled `BET` | `BET_ALREADY_SETTLED` while a referencing `WIN` is standing — two barriers: rule and trigger                                                           | otherwise a `WIN` followed by a `REFUND` would pay both; the legitimate path is to `ROLLBACK` the `WIN` first                                                                                                 |
| Zero amounts                | `WIN`, `LOSS` and `ROLLBACK` accept `"0.00"` with no balance effect (no entry, no version change); `BET`, `REFUND` and the initial balance require > 0 | `LOSS 0.00` and `WIN 0.00` are common in the market; free bets are out of scope                                                                                                                               |
| `OPENING`                   | internal transaction with `provider_id = 'internal'`, no round/game; cannot be sent through API/queue; `providerId = "internal"` is reserved (400)     | the initial balance is also in the ledger and auditable                                                                                                                                                       |
| Balance on rejection        | a rejection stores the observed balance; on `PLAYER_WALLET_MISMATCH` it stores `null`                                                                  | a provider must not see the balance of another player's wallet                                                                                                                                                |
| Reconciliation              | `difference = stored − calculated`; also reports a broken chain (`chainIntact`, `firstBrokenVersion`)                                                  | detects tampering or a missing entry, not just a sum difference                                                                                                                                               |

---

## 13. Observability

- **Logs**: JSON (pino) with `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, kind, status, `failureCode` and duration; one line per HTTP request and per processed command. **Automatic redaction** of amounts, balances, `playerId`, tokens and bodies — even if logged by mistake (tested).
- **Prometheus metrics** on an internal port (9464), separate from the API. They cover what the challenge asks (transactions by status, duplicates, retries, DLQ, lock conflicts, outbox lag, latency) and the "why is it slow" question without tracing: wait for the wallet lock, duration of each transaction, duration of each publication. `dlq_depth` is read from the DLQ itself every 15 s (also counting what SQS moves on its own). Metrics never sum money.
- **Dashboard:** Prometheus (scraping the 3 instances every 5 s) and Grafana with a provisioned dashboard, started by Compose.
- **Health:** `/health/live` with no dependencies; `/health/ready` with PostgreSQL and SQS (3 s timeout) and 503 while shutting down.
- **Correlation:** `X-Correlation-Id` (accepted from the client or generated) and `X-Instance-Id` on every response; the `correlationId` is carried into published events.

---

## 14. Testing strategy

- **Unit:** domain, rules (one test per `failureCode` and for precedence), `Money` (with property tests), canonical hash, error classification, lint rules (money as `number` and imports into the domain are lint errors, tested).
- **Integration with real PostgreSQL and SQS** (Testcontainers): constraints and triggers one by one, privileges, migrations, repositories, write order, runner (lock, timeouts, retries, cancellation), use cases, atomicity, the full API (the whole status table), consumer (dedupe, DLQ, backoff, exhaustion, redrive, shutdown), outbox (several relays, death before marking, paused SQS), worker, real Keycloak, logs and metrics.
- **Real concurrency:** parallel connections in one process and **3 Bun application processes** on the same containers — the challenge's 8 scenarios, a _standard_ queue, chaos with every kind and out-of-order reversals (deadlock delta = 0), `kill -9` in the middle of a load and `SIGTERM` with an in-flight request. Critical scenarios are repeated 20× in CI.
- **Final invariant** in every integration and concurrency test: balance = ledger sum, intact version chain, every balance-moving transaction has exactly one entry.
- **No `sleep`:** condition-based waits (`waitUntil`) and a controlled clock in deadline tests.
- **Coverage gates in CI** (`src` ≥ 90%, domain ≥ 95%, every file ≥ 80%, no file missing from the report). Current: ~98.6% of `src` lines, 100% of the domain.
- Tests were written before the code for most of the project; where they were not (the HTTP layer), deliberate mutations confirmed the tests catch regressions.

---

## 15. Known limitations and trade-offs

- **Per-wallet throughput:** one operation at a time per wallet (the price of the pessimistic lock). Different wallets scale in parallel; partitioning or buffering a heavily contended wallet is out of scope.
- **A `WIN` without a reference** points to no `BET`; the "reversed bet" and "settled bet" rules do not reach it (a consequence of rounds having no lifecycle).
- **Event order is best-effort:** under failure, or with several relays in parallel, an event may arrive after later events of the same wallet (section 8). An event SQS rejects forever stays in retry (5 min cap), visible in `outbox_lag_seconds` and `last_error`, without blocking the others.
- **Sending to the DLQ is not atomic with the commit:** if the process dies between committing a `FAILED` (or a conflict) and sending to the DLQ, the redelivery is recognised by the inbox and acknowledged; the `FAILED` transaction and its event remain stored and auditable — only the DLQ signal is lost.
- **No inbox/outbox cleanup:** the tables grow; in production a job would delete old inbox rows (beyond the redrive window) and published outbox rows (after the audit period).
- **Fixed scale 2** for every currency; currencies with 0 or 3 decimals would need a per-currency scale.
- **Free bets** (`BET 0.00`) and **partial reversals** are out of scope.
- **Open-source nginx does not query readiness:** it removes instances passively (`max_fails`/`fail_timeout`); during a shutdown it keeps sending requests, which are served but can stretch the drain up to 20 s.
- **Single-entry ledger** (see section 16).
- **Local environment:** MiniStack instead of SQS (no `StartMessageMoveTask`, hence the redrive script); Keycloak secrets fixed in the versioned realm.

---

## 16. Evaluated and not implemented

- **Double-entry bookkeeping.** Each transaction would also create a counter-entry in a house account (per provider and currency), and the global sum would be zero. **Not implemented** because, in the naive design (a materialised house balance updated under a lock), the house account becomes a **global lock** per provider — exactly what the challenge forbids — and kills parallelism. If adopted, the right design would be: house accounts with _append-only_ entries only (balance computed by sum, no lock), only the player wallet with a locked balance, and a `DEFERRABLE INITIALLY DEFERRED` constraint trigger requiring one entry on each side per transaction. It must be part of the initial schema.
- **OpenTelemetry.** It would give a span tree per request; on Bun, auto-instrumentation is still immature (no preload, HTTP and the AWS SDK not guaranteed), which would require manual spans throughout the code. The per-step timing metrics and the `correlationId` cover the main diagnostics.
- **Strict per-wallet event ordering** and **parking poison events** — evaluated and reverted (section 8).
