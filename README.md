# Distributed Wagering Processor

**Português** · [English](README.en.md)

Serviço financeiro de apostas: wallets com ledger auditável, transações `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` recebidas por **HTTP** e por **SQS**, idempotência persistente, inbox/outbox transacional e processamento correto com **várias instâncias**.

- Stack: Bun 1.4.4 · TypeScript estrito · NestJS 12 · PostgreSQL 17 · MikroORM 7 · SQS (MiniStack) · Keycloak · pino · Prometheus.
- Decisões, trade-offs e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Sumário

1. [Pré-requisitos](#1-pré-requisitos)
2. [Subir a stack completa](#2-subir-a-stack-completa)
3. [Autenticação](#3-autenticação)
4. [Usando a API](#4-usando-a-api)
5. [Usando a fila SQS](#5-usando-a-fila-sqs)
6. [Códigos de status HTTP](#6-códigos-de-status-http)
7. [Observabilidade e operação](#7-observabilidade-e-operação)
8. [Rodar a aplicação fora do Docker](#8-rodar-a-aplicação-fora-do-docker)
9. [Testes](#9-testes)
10. [Requisitos do desafio → testes que os provam](#10-requisitos-do-desafio--testes-que-os-provam)
11. [Teste de carga](#11-teste-de-carga)
12. [Comandos](#12-comandos)
13. [Estrutura do projeto](#13-estrutura-do-projeto)

---

## 1. Pré-requisitos

- **Docker** com Docker Compose v2.
- **Bun 1.4.4** (`curl -fsSL https://bun.sh/install | bash -s bun-v1.4.4`) — necessário para os testes, os scripts e para obter tokens.
- Portas livres no host: `8080` (API via nginx), `8081` (Keycloak), `55432` (PostgreSQL), `4566` (SQS), `9090` (Prometheus), `3001` (Grafana).

```bash
bun install
```

---

## 2. Subir a stack completa

```bash
docker compose up -d --build --wait
curl -s localhost:8080/health/ready    # {"status":"up","checks":{"database":"up","sqs":"up","shuttingDown":false}}
```

O Compose sobe, nesta ordem:

| Serviço                   | O que faz                                                                                                                | Porta no host |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `postgres`                | PostgreSQL 17 (databases `wagering` e `keycloak`; papéis `migrator` e `app`)                                             | `55432`       |
| `ministack`               | Emulador de SQS                                                                                                          | `4566`        |
| `migrator`                | Aplica as migrations com o papel `migrator` e termina                                                                    | —             |
| `sqs-init`                | Cria as filas FIFO (`wager-transactions`, sua DLQ com `maxReceiveCount = 8`, `wallet-events`) e termina                  | —             |
| `keycloak`                | Provedor de identidade com o realm `wagering` importado                                                                  | `8081`        |
| `app-1`, `app-2`, `app-3` | Três instâncias da aplicação, cada uma com **todos os papéis**: API, consumer SQS, relay da outbox e worker de pendentes | —             |
| `nginx`                   | Porta única da API, round-robin entre as três instâncias                                                                 | `8080`        |
| `prometheus`              | Coleta as métricas das três instâncias a cada 5 s                                                                        | `9090`        |
| `grafana`                 | Dashboard pronto ("Wagering processor"), acesso anônimo de leitura                                                       | `3001`        |

Toda resposta traz `X-Instance-Id` (qual instância atendeu) e `X-Correlation-Id`:

```bash
for i in 1 2 3; do curl -s -D - -o /dev/null localhost:8080/health/live | grep -i x-instance-id; done
```

Para parar: `docker compose down` (mantém os dados) ou `docker compose down -v` (apaga o volume do PostgreSQL).

---

## 3. Autenticação

JWT emitido pelo Keycloak (fluxo `client_credentials`), validado pela API via JWKS (assinatura, `iss`, `aud` e `exp`).

| Client                     | Papel      | Pode                                                               |
| -------------------------- | ---------- | ------------------------------------------------------------------ |
| `provider-a`, `provider-b` | `provider` | `POST /wagering/transactions`; ler **as próprias** transações      |
| `backoffice`               | `operator` | criar e ler wallets, ledger, reconciliação, ler qualquer transação |

```bash
export OP=$(bun scripts/auth-token.ts backoffice)
export PA=$(bun scripts/auth-token.ts provider-a)
```

> Os segredos dos clients (`<client>-secret`) estão fixos no realm versionado para uso **local**. Em qualquer outro ambiente eles devem vir de um cofre de segredos.

A identidade do provedor vem do token (`azp`). Um `providerId` diferente no corpo ou no caminho é recusado com **403 `PROVIDER_IDENTITY_MISMATCH`** e nada é gravado. Os endpoints de health e `/docs-json` são abertos.

---

## 4. Usando a API

O contrato OpenAPI 3.1 está em `GET /docs-json`. Exemplos com `curl` (depois de exportar `OP` e `PA`):

**Criar wallet** (operador). Saldo inicial > 0 gera uma transação interna `OPENING` com lançamento `CREDIT`, na mesma transação SQL.

```bash
export PLAYER=$(bun -e 'console.log(Bun.randomUUIDv7())')
curl -s -X POST localhost:8080/wallets \
  -H "authorization: Bearer $OP" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"
# 201 {"id":"...","playerId":"...","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
export WALLET=<id da resposta>
```

**Submeter uma aposta** (provedor). O header `Idempotency-Key` é obrigatório.

```bash
curl -s -X POST localhost:8080/wagering/transactions \
  -H "authorization: Bearer $PA" -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# 200 {"transactionId":"...","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

- Repetir **a mesma** requisição → `200` com o **mesmo** resultado e `"idempotentReplay": true`.
- Mesma key com payload diferente → `409 IDEMPOTENCY_CONFLICT`.
- Mesmo `externalTransactionId` com outra key → `409 EXTERNAL_TRANSACTION_ID_CONFLICT`.
- Saldo insuficiente → `422` com `"status":"REJECTED","failureCode":"INSUFFICIENT_BALANCE"` (a rejeição fica gravada).
- `ROLLBACK`/`REFUND` cuja referência ainda não chegou → `202` com `"status":"PENDING_REFERENCE"`; o worker resolve quando a referência chegar.

**Consultas**

```bash
curl -s localhost:8080/wallets/$WALLET -H "authorization: Bearer $OP"
curl -s "localhost:8080/wallets/$WALLET/ledger?limit=50" -H "authorization: Bearer $OP"   # mais recentes primeiro; use nextCursor
curl -s localhost:8080/wagering/transactions/<transactionId> -H "authorization: Bearer $PA"
curl -s localhost:8080/providers/provider-a/wagering/transactions/tx-1 -H "authorization: Bearer $PA"
```

**Reconciliação** (operador) — compara o saldo gravado com o saldo reconstruído pelo ledger, numa única consulta em snapshot. Divergência é logada, contada em métrica e sinalizada; **nunca** corrigida automaticamente.

```bash
curl -s -X POST localhost:8080/wallets/$WALLET/reconciliation -H "authorization: Bearer $OP"
# {"walletId":"...","storedBalance":{...},"calculatedBalance":{...},"difference":{"amount":"0.00",...},"consistent":true,"checkedEntries":2,"chainIntact":true,"firstBrokenVersion":null}
```

**Health** (sem autenticação): `GET /health/live` (processo vivo) e `GET /health/ready` (PostgreSQL e SQS alcançáveis; `503` durante o desligamento).

### Regras de entrada

- Dinheiro é sempre `{"amount": "<string>", "currency": "<ISO-4217>"}`, com **exatamente duas casas** (`"25.00"`). Número JSON, vírgula, escala diferente de 2 ou moeda em minúsculas → `400` com código específico.
- `BET`, `REFUND` e o saldo inicial exigem valor > 0. `WIN`, `LOSS` e `ROLLBACK` aceitam `"0.00"` (sem efeito no saldo).
- `walletId`/`playerId` são UUID; `providerId`, `externalTransactionId`, `roundId`, `gameId` e `referenceExternalTransactionId` têm 1–120 caracteres ASCII imprimíveis; `providerId = "internal"` é reservado.
- `Idempotency-Key`: 1–255 caracteres ASCII imprimíveis, sem espaços nas pontas. Recomendado: `"{providerId}:{externalTransactionId}"`.
- Campos desconhecidos são recusados. Corpo só `application/json`, até 64 KB.

---

## 5. Usando a fila SQS

O consumer de cada instância lê `wager-transactions.fifo` e usa **o mesmo caso de uso** da API. Mensagem:

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

Publicar uma mensagem de teste:

```bash
bun run publish:wager "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"sqs-1\",\"idempotencyKey\":\"provider-a:sqs-1\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-1\",\"gameId\":\"g\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}"
```

| Situação                                                                  | O que o consumer faz                                                                                                                                       |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Processada, rejeitada por regra de negócio ou replay                      | grava, confirma o commit e **só então** apaga a mensagem (ack)                                                                                             |
| Já processada (mesmo `messageId`)                                         | reconhece pela inbox persistente e apaga, sem efeito                                                                                                       |
| Erro transitório (banco ou rede)                                          | não apaga; devolve com backoff `15 s, 30 s, 60 s … 300 s`; após 8 entregas o SQS move para a DLQ — **nenhum `FAILED` é gravado**, então o redrive funciona |
| Payload inválido, tipo desconhecido, conflito de idempotência ou de inbox | envia à DLQ (com novo `MessageDeduplicationId`) e apaga                                                                                                    |
| Erro determinístico inesperado (ex.: saldo acima de `NUMERIC(19,2)`)      | grava `FAILED (UNEXPECTED_PROCESSING_ERROR)` com evento e envia à DLQ                                                                                      |

**Recomendação aos produtores:** `MessageGroupId = walletId` e `MessageDeduplicationId = messageId`. A correção **não depende** disso: a idempotência e as invariantes estão no PostgreSQL (há teste com fila _standard_).

**Redrive da DLQ** (depois de resolver a causa):

```bash
bun run dlq:redrive     # receive → send à fila original (novo MessageDeduplicationId, mesmo grupo) → delete
```

O MiniStack não suporta `StartMessageMoveTask`, por isso o redrive é um script. A inbox deduplica pelo `messageId` do corpo, então reprocessar é seguro.

**Eventos publicados** (`wallet-events.fifo`, `MessageGroupId = walletId`): `WagerTransactionProcessed`, `WalletBalanceChanged`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WagerTransactionFailed`. Entrega **pelo menos uma vez**: o consumidor deve deduplicar por `eventId` e, para saldo, aplicar pela `walletVersion`.

---

## 6. Códigos de status HTTP

Uma tabela única para todos os endpoints. Erros seguem o RFC 9457 (`application/problem+json` com `type`, `title`, `status`, `code`, `detail`, `correlationId`).

| HTTP | Significado                                                                                                                                                                  | Reenviar?                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 200  | processada, replay ou leitura                                                                                                                                                | —                                        |
| 201  | wallet criada                                                                                                                                                                | —                                        |
| 202  | aceita, aguardando a referência (`PENDING_REFERENCE`)                                                                                                                        | seguro, sem efeito                       |
| 400  | payload inválido: `INVALID_PAYLOAD`, `INVALID_AMOUNT_FORMAT`, `INVALID_AMOUNT_SCALE`, `INVALID_AMOUNT_ZERO`, `INVALID_CURRENCY`, `IDEMPOTENCY_KEY_MISSING`, `INVALID_CURSOR` | não, corrija o payload                   |
| 401  | `UNAUTHENTICATED` (token ausente, inválido ou expirado)                                                                                                                      | após renovar o token                     |
| 403  | `FORBIDDEN` (papel sem acesso) ou `PROVIDER_IDENTITY_MISMATCH`                                                                                                               | não                                      |
| 404  | `NOT_FOUND` (inclusive transação de outro provedor)                                                                                                                          | não                                      |
| 409  | `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `WALLET_ALREADY_EXISTS`                                                                                          | não                                      |
| 422  | rejeição de negócio (`status: REJECTED` + `failureCode`) ou erro determinístico (`status: FAILED`)                                                                           | não — reenviar devolve o mesmo resultado |
| 503  | falha transitória de infraestrutura (`SERVICE_UNAVAILABLE`), com `Retry-After`                                                                                               | **sim**, com a mesma key                 |
| 500  | erro inesperado fora do processamento de transações (`INTERNAL_ERROR`)                                                                                                       | seguro                                   |

Os `failureCode` possíveis estão em [`ARCHITECTURE.md`](ARCHITECTURE.md#9-taxonomia-de-falhas).

---

## 7. Observabilidade e operação

- **Logs** JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, tipo, status, `failureCode` e duração. Valores, saldos, `playerId`, tokens e corpos **nunca** são logados (redação automática).

  ```bash
  docker compose logs -f app-1
  ```

- **Métricas Prometheus** em `/metrics` numa porta **interna** (`9464`), separada da API e não publicada no host:

  ```bash
  docker compose exec app-1 bun -e "console.log(await (await fetch('http://127.0.0.1:9464/metrics')).text())"
  ```

  Principais: `wager_transactions_total{status,kind}`, `idempotent_replays_total`, `idempotency_conflicts_total`, `inbox_duplicates_total`, `processing_retries_total{reason}`, `dlq_messages_total{reason}`, `dlq_depth`, `lock_conflicts_total`, `db_deadlocks_total`, `outbox_lag_seconds`, `processing_duration_seconds{channel}`, `wallet_lock_wait_seconds`, `db_transaction_duration_seconds`, `reconciliation_divergence_total`.

- **Dashboard:** abra `http://localhost:3001` (Grafana, sem login). O painel "Wagering processor" mostra transações por status e tipo, duplicatas e conflitos, latência p50/p95/p99, espera pelo lock da wallet, retries, conflitos de lock e deadlocks, DLQ, atraso da outbox, divergências de reconciliação e instâncias no ar. O Prometheus fica em `http://localhost:9090`.
- **Acessar uma instância específica:** as instâncias não publicam portas; use `docker compose exec app-2 …` (como acima) ou observe `X-Instance-Id` nas respostas do nginx.
- **nginx:** o balanceamento é round-robin. O nginx open source **não** consulta o readiness: uma instância é retirada de forma passiva depois de falhas de conexão (`max_fails=2`, `fail_timeout=10s`), e POSTs não são reenviados a outra instância.
- **Desligamento (`SIGTERM`):** readiness passa a `503`; em paralelo, o consumer termina as mensagens em andamento e as requisições HTTP em andamento terminam (o listener continua aceitando durante a drenagem). Uma mensagem SQS que passar de 20 s tem a transação cancelada (rollback) e volta à fila; depois fecham o listener e o pool e o processo sai com código 0, dentro dos 30 s do `stop_grace_period`.

---

## 8. Rodar a aplicação fora do Docker

```bash
docker compose up -d --wait postgres ministack keycloak
bun run migrate:up               # usa DATABASE_MIGRATOR_URL
bun run sqs:init
cp .env.example .env             # Bun carrega o .env automaticamente
bun run start                    # papéis definidos em APP_ROLES; API em :3000, métricas em :9464
```

`APP_ROLES` aceita qualquer combinação de `api`, `sqs-consumer`, `outbox-relay` e `pending-reference-worker`. Todas as variáveis (timeouts, pool, backoff, TTL das pendentes) são validadas na subida; veja `src/config/config.schema.ts`.

---

## 9. Testes

Os testes de integração e concorrência sobem **PostgreSQL e MiniStack reais** em containers (Testcontainers) — Docker precisa estar rodando. Nada de banco ou fila é simulado.

```bash
bun run test:unit            # domínio, regras, Money, classificação de erros (sem Docker)
bun run test:integration     # banco, repositórios, casos de uso, HTTP, SQS, outbox, worker, Keycloak, logs e métricas
bun run test:concurrency     # paralelismo real; inclui a suíte com 3 processos Bun da aplicação
bun run test:coverage        # unit + integração com limites: src ≥ 90%, domínio ≥ 95%, cada arquivo ≥ 80%
REPEAT=20 bun test tests/concurrency/multi-process -t "README scenario (1|2|5) "   # repetição dos cenários críticos
```

Ao fim de cada teste de integração e de concorrência, uma asserção confere em **todas** as wallets: saldo = soma do ledger, corrente de versões contínua, toda transação `PROCESSED` que move saldo tem exatamente um lançamento.

---

## 10. Requisitos do desafio → testes que os provam

### Testes obrigatórios

| Requisito                                                                      | Onde                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operações e validações de `Money` (escala, arredondamento, entradas inválidas) | `tests/unit/shared/money.test.ts`, `money.property.test.ts`                                                                                                         |
| Invariantes da `Wallet`                                                        | `tests/unit/wallet/wallet.test.ts`, `wallet-ledger-entry.test.ts`                                                                                                   |
| Regras de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`                           | `tests/unit/wagering/wager-rules.test.ts`, `wager-transaction.test.ts`                                                                                              |
| Conflito de moeda                                                              | `wager-rules.test.ts` (`CURRENCY_MISMATCH`), `money.test.ts`                                                                                                        |
| Idempotency key com payload divergente                                         | `tests/unit/wagering/wager-transaction.test.ts` (`matchesPayload`), `tests/integration/use-cases/process-wager.test.ts`, `tests/integration/http/api.test.ts` (409) |
| Migrations e constraints                                                       | `tests/integration/db/migrations.test.ts`, `constraints.test.ts`, `privileges.test.ts`                                                                              |
| Atomicidade entre wallet, ledger, inbox e outbox                               | `tests/integration/use-cases/atomicity-and-reconcile.test.ts`, `persistence/write-order.test.ts`                                                                    |
| Inbox e redelivery                                                             | `tests/integration/messaging/sqs-consumer.test.ts`                                                                                                                  |
| Publishers concorrentes sobre a mesma outbox                                   | `outbox-relay.test.ts` (dois relays, 200 eventos), `multi-process/cluster-scenarios.test.ts` (cenários 4 e 6)                                                       |
| Retry e DLQ                                                                    | `sqs-consumer.test.ts` (backoff, esgotamento, DLQ, redrive)                                                                                                         |
| Recuperação após reinicialização                                               | `multi-process/crash-and-restart.test.ts` (cenário 8)                                                                                                               |
| 1. A mesma aposta 50× em paralelo → um único débito                            | `concurrency/use-case/same-bet-50x.test.ts`; com 3 processos, por HTTP e SQS: `cluster-scenarios.test.ts` (cenário 1)                                               |
| 2. Duas apostas de 80 com saldo 100                                            | `concurrency/use-case/two-bets-80.test.ts`; `cluster-scenarios.test.ts` (cenário 2)                                                                                 |
| 3. Wallets distintas em paralelo                                               | `concurrency/use-case/distinct-wallets.test.ts`; `cluster-scenarios.test.ts` (cenário 3)                                                                            |
| 4. ≥ 3 processos simultâneos                                                   | toda a pasta `tests/concurrency/multi-process/` (3 processos Bun reais)                                                                                             |
| 5. Worker morto depois do commit e antes do ack                                | `crash-and-restart.test.ts` (cenário 5, `SIGKILL` real) e `sqs-consumer.test.ts`                                                                                    |
| 6. Dois publishers sobre a mesma outbox                                        | `outbox-relay.test.ts`; `cluster-scenarios.test.ts` (cenário 6)                                                                                                     |
| 7. `ROLLBACK`/`REFUND` antes da referência                                     | `tests/integration/wagering/pending-reference.test.ts`; `cluster-scenarios.test.ts` (cenário 7)                                                                     |
| 8. Reinício com consistência final                                             | `crash-and-restart.test.ts` (cenário 8, `kill -9` nas 3 instâncias)                                                                                                 |
| Invariante final `wallet.balance == ledger`                                    | `tests/support/invariants.ts`, chamada ao fim de cada teste de integração e concorrência                                                                            |

### Restrições invioláveis

| Restrição                                    | Como é garantida                                                                                               | Teste                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Sem `number` para dinheiro                   | `Money` sobre `decimal.js`, colunas `NUMERIC(19,2)` lidas como string; regra de lint proíbe conversões         | `money.test.ts`, `persistence/money-roundtrip.test.ts`, `tooling/lint-rules.test.ts`, `api.test.ts` (respostas sem números) |
| Idempotência não é cache em memória          | `UNIQUE (provider_id, idempotency_key)` e inbox no PostgreSQL                                                  | `constraints.test.ts`, `same-bet-50x.test.ts`, `cluster-scenarios.test.ts`                                                  |
| Não depender só do SQS FIFO                  | as garantias estão no banco                                                                                    | `cluster-scenarios.test.ts` (fila _standard_ com duplicatas)                                                                |
| Nenhum evento antes do commit                | outbox na mesma transação; relay só lê o que foi confirmado                                                    | `outbox-relay.test.ts` (transação aberta é invisível)                                                                       |
| Ledger nunca sobrescrito nem apagado         | trigger que recusa `UPDATE`/`DELETE` + papel `app` sem esses privilégios                                       | `constraints.test.ts`, `privileges.test.ts`                                                                                 |
| Sem lock global                              | lock pessimista **por wallet**                                                                                 | `distinct-wallets.test.ts` (paralelo mais rápido que sequencial)                                                            |
| Sem `read → calculate → update` sem controle | `SELECT … FOR UPDATE` + `UPDATE … WHERE version = ?` + `UNIQUE (wallet_id, wallet_version)`                    | `persistence/runner.test.ts`, `two-bets-80.test.ts`                                                                         |
| Correto com várias instâncias                | tudo acima, no banco                                                                                           | `tests/concurrency/multi-process/*`                                                                                         |
| Garantias no schema                          | `CHECK`, `UNIQUE`, FKs, índices parciais, triggers e constraint triggers no commit (saldo = último lançamento) | `constraints.test.ts`                                                                                                       |

---

## 11. Teste de carga

`bun run test:load` (com a stack do Compose no ar) mede a API real através do nginx e, no fim, reconcilia **todas** as wallets usadas. Parâmetros por variável de ambiente: `LOAD_DURATION_S` (60), `LOAD_CONCURRENCY` (32), `LOAD_WALLETS` (200), `LOAD_HOT_SHARE` (0.2 — fração das apostas numa única wallet, para forçar disputa de lock), `LOAD_REPLAY_SHARE` (0.1 — fração de replays idempotentes).

**Resultado medido** (todos os serviços na mesma máquina: Intel i5-11400H, 12 CPUs lógicas, 15,4 GiB; 3 instâncias da app, nginx, PostgreSQL, MiniStack e Keycloak via Docker Compose; 60 s, 32 clientes, 200 wallets, 20% numa wallet quente, 10% de replays, cada requisição uma `BET` de 1,00):

| Métrica                                 | Valor                                       |
| --------------------------------------- | ------------------------------------------- |
| Requisições                             | 35.884 em 60,1 s                            |
| Vazão                                   | 597 req/s, todas respondidas com 200        |
| Latência p50 / p95 / p99 / máx.         | 19,2 / 310,3 / 553,5 / 1.509,9 ms           |
| Taxa de erro (5xx ou sem resposta)      | 0,00%                                       |
| Replays enviados                        | 3.561                                       |
| Conflitos de lock / deadlocks / retries | 0 / 0 / 0                                   |
| Atraso máximo da outbox durante a carga | 97 s                                        |
| Escoamento da outbox depois da carga    | 465 s para publicar todos os 65.046 eventos |
| Reconciliação de todas as wallets       | 200 consistentes, 0 inconsistentes          |

**Análise honesta:**

- **Correção sob carga:** nenhum erro, nenhum deadlock, nenhum retry, e todas as wallets com saldo igual ao ledger.
- **Latência:** p50 baixo; o p95/p99 alto vem da wallet quente — 20% das apostas disputam o mesmo lock e são processadas uma por vez (limitação conhecida do lock por wallet).
- **Gargalo: a publicação da outbox.** Cada aposta gera 2 eventos (≈ 1.200 eventos/s), mas o relay publicou ≈ 120 eventos/s neste ambiente: ele envia um `SendMessage` por evento, em sequência dentro de cada wallet, e a wallet quente concentra 20% dos eventos. Nada se perde (a outbox é durável e o atraso aparece em `outbox_lag_seconds`), mas sob carga sustentada os eventos chegam com minutos de atraso. Melhorias naturais, não implementadas: `SendMessageBatch` (10 por chamada), lotes maiores e mais paralelismo por instância.
- **Limites do experimento:** uma única máquina para tudo (o gerador de carga compete pela mesma CPU), MiniStack no lugar do SQS real, uma execução — os números indicam ordem de grandeza, não capacidade de produção.

---

## 12. Comandos

| Comando                                                                         | O que faz                                          |
| ------------------------------------------------------------------------------- | -------------------------------------------------- |
| `bun run start`                                                                 | inicia a aplicação com os papéis de `APP_ROLES`    |
| `bun run migrate:up` / `bun run migrate:down [n]`                               | aplica / desfaz `n` migrations (padrão 1)          |
| `bun run sqs:init`                                                              | cria as filas (idempotente)                        |
| `bun run publish:wager '<data JSON>'`                                           | publica uma `WagerTransactionRequested`            |
| `bun run dlq:redrive`                                                           | devolve as mensagens da DLQ para a fila de entrada |
| `bun run auth:token <client>`                                                   | imprime um access token do Keycloak                |
| `bun run lint` / `typecheck` / `format:check`                                   | qualidade de código                                |
| `bun run test:unit` / `test:integration` / `test:concurrency` / `test:coverage` | testes                                             |
| `bun run test:load`                                                             | teste de carga contra a stack no ar (seção 11)     |

**Pre-commit** (lint, typecheck e testes unitários): `git config core.hooksPath .githooks`.

A CI (`.github/workflows/ci.yml`) roda lint, formatação, typecheck, unitários, integração com cobertura e a suíte de concorrência com `REPEAT=20` nos cenários críticos.

---

## 13. Estrutura do projeto

```
src/
  main.ts · app.module.ts · http-app.ts      bootstrap por papéis e composição
  config/                                    variáveis de ambiente validadas (Zod)
  shared/                                    Money, hash canônico, relógio, ids, backoff
  modules/
    wallet/      domain · application · infrastructure · interface
    wagering/    domain (regras, estados) · application (casos de uso, worker) · infrastructure · interface (HTTP, mensagem SQS)
    messaging/   domain (inbox, outbox, eventos) · infrastructure (SQS, relay, consumer, redrive)
    identity/    JWT/JWKS, guarda, papéis
    observability/ · health/
  infrastructure/
    db/          MikroORM, migrations, WalletTransactionRunner, classificação de erros
    http/        problem details, validação, correlação, OpenAPI
    fault/       injeção de falhas para os testes de queda
tests/  unit · integration · concurrency · support
docker/ postgres · keycloak · nginx
scripts/ migrate · sqs-init · dlq-redrive · publish-wager-message · auth-token · coverage-check
```
