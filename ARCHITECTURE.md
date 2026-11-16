# Arquitetura

**Português** · [English](ARCHITECTURE.en.md)

Este documento explica **como** o serviço garante a correção financeira e **por que** cada escolha foi feita, com as alternativas consideradas, os trade-offs e as limitações. Setup e uso estão no [`README.md`](README.md).

## Sumário

1. [Princípios](#1-princípios)
2. [Visão geral](#2-visão-geral)
3. [Modelo de domínio](#3-modelo-de-domínio)
4. [Persistência: ORM, `Money` e estratégia transacional](#4-persistência-orm-money-e-estratégia-transacional)
5. [Fluxo de processamento de uma transação](#5-fluxo-de-processamento-de-uma-transação)
6. [Concorrência](#6-concorrência)
7. [Idempotência](#7-idempotência)
8. [Mensageria: inbox, outbox, consumer, DLQ](#8-mensageria-inbox-outbox-consumer-dlq)
9. [Taxonomia de falhas](#9-taxonomia-de-falhas)
10. [Referências fora de ordem](#10-referências-fora-de-ordem)
11. [API HTTP e autenticação](#11-api-http-e-autenticação)
12. [Interpretações das regras de negócio](#12-interpretações-das-regras-de-negócio)
13. [Observabilidade](#13-observabilidade)
14. [Estratégia de testes](#14-estratégia-de-testes)
15. [Limitações e trade-offs conhecidos](#15-limitações-e-trade-offs-conhecidos)
16. [Avaliado e não implementado](#16-avaliado-e-não-implementado)

---

## 1. Princípios

1. **O banco é a fonte da verdade das invariantes.** Toda garantia de unicidade, imutabilidade e não-negatividade existe no schema (`CHECK`, `UNIQUE`, FKs, índices parciais, triggers e privilégios), não só em código. A aplicação pode ter bugs; o PostgreSQL recusa o estado inválido.
2. **Correção financeira não depende da disponibilidade.** Deadlocks, timeouts, SQS fora do ar e quedas de processo afetam a latência, nunca o saldo: tudo é transacional e idempotente, e o que falha é repetido com segurança.
3. **Determinismo.** A mesma requisição produz sempre a mesma resposta; replays são montados só com dados gravados.
4. **Simplicidade com justificativa.** Cada mecanismo extra existe para atender a um requisito; o que não é exigido e traz risco foi avaliado e documentado, não implementado.

---

## 2. Visão geral

**Monólito modular hexagonal** em NestJS sobre Bun. O domínio é TypeScript puro (sem NestJS nem MikroORM — garantido por regra de lint); casos de uso orquestram; adaptadores (HTTP, SQS, PostgreSQL) ficam nas bordas.

```
                 ┌──────────────┐    HTTP (JWT)      ┌──────────────────────────────────────────────┐
  provedores ───▶│    nginx     │──round-robin──────▶│ app-1 / app-2 / app-3 (mesma imagem)         │
  operador   ───▶│    :8080     │                    │  papéis: api · sqs-consumer · outbox-relay · │
                 └──────────────┘                    │          pending-reference-worker            │
                                                     └──────┬──────────────┬──────────────┬─────────┘
  wager-transactions.fifo ──────(consumer)──────────────────┘              │              │
  wager-transactions-dlq.fifo ◀─(permanentes / esgotadas)                  │              │
                                                                   PostgreSQL 17     wallet-events.fifo
                                                         (wallets, ledger, transações,  ◀──(relay)
                                                          inbox, outbox, providers)
```

- **Uma imagem, vários papéis** (`APP_ROLES`). No Compose, as 3 instâncias rodam todos os papéis; cada papel funciona com N instâncias porque toda coordenação passa pelo banco (locks de linha, leases, `SKIP LOCKED`, constraints).
- **Módulos:** `wallet`, `wagering`, `messaging`, `identity`, `observability`, `health`, mais `shared` (Money, hash canônico, relógio, ids, backoff) e `infrastructure` (banco, HTTP, injeção de falhas).
- **Um único ponto abre transação e trava wallet:** `WalletTransactionRunner`. Casos de uso nunca chamam `FOR UPDATE` diretamente.

---

## 3. Modelo de domínio

As invariantes ficam **dentro das classes**, com estado privado e transições explícitas.

### `Money`

- `decimal.js` com precisão de sobra; **escala fixa 2**; imutável; nunca arredonda.
- Entrada só por string no formato `^(0|[1-9]\d{0,16})\.\d{2}$` (cabe em `NUMERIC(19,2)`). Número JSON, `"25.5"`, `"25,00"`, `"1e3"`, `"-1.00"`, `"NaN"` são recusados com códigos distintos (`INVALID_AMOUNT_FORMAT`, `INVALID_AMOUNT_SCALE`).
- Operações entre moedas diferentes lançam `CurrencyMismatchError`. Serializa como `{ "amount": "25.00", "currency": "BRL" }` — nunca número.
- Testes de propriedade (fast-check) para comutatividade, ida e volta e formato.

### `Wallet` (aggregate root)

- Saldo e versão só mudam por `debit()`/`credit()`, que devolvem o `WalletLedgerEntry` correspondente (`balanceBefore ± amount = balanceAfter`, `walletVersion` = versão nova). Débito que deixaria saldo negativo é recusado.
- `Wallet.open()` com saldo > 0 exige a transação de abertura e gera o lançamento `CREDIT` na versão 1.

### `WagerTransaction` (máquina de estados)

```
           ┌──────────────▶ PROCESSED
 PENDING ──┼──────────────▶ REJECTED (failureCode)
 (memória) ├──────────────▶ FAILED (UNEXPECTED_PROCESSING_ERROR)
           └─▶ PENDING_REFERENCE ──▶ PROCESSED | REJECTED   (só pelo worker)
```

- `PENDING` existe só em memória: a linha **nasce já no estado final** (o `CHECK` de status nem aceita `PENDING`).
- `PROCESSED`, `REJECTED` e `FAILED` são terminais — garantido também por trigger, que ainda recusa mudar colunas imutáveis (provider, ids, key, hash, wallet, player, rodada, jogo, tipo, valor, moeda).

### `WalletLedgerEntry`

Imutável (congelado em runtime), `amount > 0`, aritmética conferida na fábrica e por `CHECK` no banco. O ledger é **encadeado** por `wallet_version`: `UNIQUE (wallet_id, wallet_version)`, e cada lançamento começa onde o anterior terminou — a reconciliação detecta qualquer quebra.

### `InboxMessage`, `OutboxMessage` e eventos de integração

Classes com `eventType`/`version` estáticos (nenhuma string solta); payload congelado; backoff da outbox pela fórmula única `min(base × 2^n × jitter[0,8; 1,2], teto)`.

---

## 4. Persistência: ORM, `Money` e estratégia transacional

### Por que MikroORM (v7)

É o ORM preferido pelo desafio e oferece `em.transactional()`, `LockMode` e controle de SQL explícito. Foi validado numa prova de conceito com Bun antes de começar (migrations programáticas, `NUMERIC` como string, `FOR UPDATE` dentro de transação).

### Como ele é usado — e por que não pelo Unit of Work

- **Records + mappers:** o domínio não conhece o ORM. Cada tabela tem um _record_ (`EntitySchema`) e um mapper que reconstrói o domínio sempre por `rehydrate` (testado com espiões).
- **SQL explícito no caminho transacional:** escritas por `em.insert`/`em.nativeUpdate` e leituras por SQL com lista de colunas. **Nunca** `persist`/`flush`.
  - O `flush` reordena INSERTs e UPDATEs por conta própria e poderia inserir o lançamento antes da transação que ele referencia (violação de FK); um teste verifica a ordem real dos comandos.
  - O _identity map_ devolveria o estado antigo de uma wallet depois de um `nativeUpdate` na mesma transação.
  - A checagem de versão é explícita (`UPDATE … WHERE id = ? AND version = ?`, 0 linhas ⇒ conflito), em vez do `version: true` do ORM.

### Mapeamento do `Money`

Colunas `NUMERIC(19,2)` + moeda `CHAR(3)` com `CHECK`. O driver `pg` devolve `NUMERIC` como string; os records tipam essas colunas como `string`, e o mapper chama `Money.from` — dinheiro nunca passa por `number` em nenhuma camada (há teste com `"99999999999999999.99"` ida e volta). O overflow de `NUMERIC(19,2)` é detectado pelo banco (`22003`) e tratado como erro determinístico.

### Estratégia transacional (`WalletTransactionRunner`)

- `READ COMMITTED` + lock pessimista por wallet (seção 6).
- Logo após o `BEGIN`: `lock_timeout = 5s`, `statement_timeout = 10s`, `idle_in_transaction_session_timeout = 30s` (locais à transação).
- Repetição por **classe de erro**: transitório → até 3 tentativas com jitter; violação de unicidade → rollback e reexecução da unidade inteira (até 2 vezes); determinístico → sobe na hora.
- Cancelamento por `AbortSignal` (fecha a sessão no banco ⇒ rollback), usado no shutdown.
- Timeouts do cliente: conexão e pool 5 s, query 15 s, SQS 5 s/10 s — com o banco ou o SQS travados, nada fica pendurado (há teste com o Postgres pausado: 503 em menos de 20 s).

### Papéis do banco (menor privilégio)

- `migrator`: dono do schema; só roda migrations.
- `app`: runtime. `SELECT` em `providers`; `SELECT, INSERT` no ledger (**sem** `UPDATE`/`DELETE`); `SELECT, INSERT, UPDATE` no resto. Testado.

### Migrations

SQL escrito à mão, reversível (`up`/`down`), executado por script programático. Testes: `up → down → up`, desfazer um passo por vez.

---

## 5. Fluxo de processamento de uma transação

O **mesmo caso de uso** (`ProcessWagerTransaction`) atende HTTP e SQS; o núcleo que decide e grava (`WagerProcessor`) é reutilizado pelo worker de pendentes.

**Antes da transação:** valida o payload (400 / DLQ) e calcula o `payloadHash`.

**Ordem por canal:**

- **HTTP:** leitura sem lock pela key → se existe, responde o replay sem abrir transação.
- **SQS:** `BEGIN` → INSERT na inbox (duplicata ⇒ ack sem efeito) → leitura pela key → se existe, replay.

**Dentro da transação — ordem de escrita fixa:**

1. trava a wallet (`SELECT … FOR UPDATE`, se existir) e **relê a key sob o lock** (corrida ⇒ replay);
2. id externo já usado com outra key ⇒ `EXTERNAL_TRANSACTION_ID_CONFLICT`;
3. decide em memória (`decideWager`: regras numa ordem fixa, a primeira violação vence);
4. `UPDATE wallets … WHERE version = ?` (só se o saldo muda);
5. `INSERT` da transação **já no estado final**, com o saldo observado;
6. `INSERT` do lançamento no ledger (só se o saldo muda);
7. acelera as pendentes que esperam por esta transação;
8. `INSERT` dos eventos na outbox;
9. (SQS) marca a inbox; `COMMIT`; só então `DeleteMessage`.

Qualquer erro antes do commit desfaz **tudo** junto: saldo, transação, ledger, inbox e outbox (testado com falha injetada depois do lançamento e antes do commit).

---

## 6. Concorrência

**Unidade de concorrência: a wallet.**

### Estratégia escolhida: lock pessimista por wallet, com barreiras extras

- `SELECT … FOR UPDATE` na linha da wallet, em `READ COMMITTED`.
- Barreiras independentes do lock: `UPDATE … WHERE version = ?`, `UNIQUE (wallet_id, wallet_version)` no ledger e `CHECK (balance >= 0)`.

| Alternativa                                             | Por que não                                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Lock otimista com retry                                 | na wallet disputada (50 requisições paralelas, cenário obrigatório) vira tempestade de retries e pode esgotar o limite |
| `UPDATE … SET balance = balance - x WHERE balance >= x` | não devolve `balanceBefore` com naturalidade para o ledger e contorna o agregado                                       |
| Lock global / fila única                                | proibido e mata o paralelismo entre wallets                                                                            |

Wallets diferentes rodam em paralelo (teste: 20 wallets × 10 apostas em paralelo é mais rápido que em sequência). Limitação aceita: **uma wallet processa uma operação por vez**.

### Prevenção de deadlock: ordem global de locks

`① inbox → ② wallet → ③ transações → ④ ledger → ⑤ outbox` — toda transação segue essa ordem, podendo pular etapas, nunca voltar; cada transação trava **no máximo uma** wallet; várias linhas do mesmo tipo sempre em ordem de id; referências não são travadas (são da mesma wallet, já travada); reserva de pendentes e da outbox com `SKIP LOCKED`; a reconciliação não pega locks.

**Alcance honesto:** isso torna o deadlock impossível _entre os caminhos inventariados, desde que a regra seja respeitada_. Código futuro pode violá-la; por isso existem a verificação (testes de caos com 3 processos medem o delta de `pg_stat_database.deadlocks` = 0) e a recuperação (deadlock é transitório: rollback completo e repetição). **A correção financeira não depende da ausência de deadlock — só a latência depende.**

### Classificação de erros: infraestrutura é transitória por padrão

- **Transitório:** deadlock, timeout de lock, serialização, `statement_timeout`, conexão, servidor reiniciando, pool esgotado, rede, conflito de versão. ⇒ repete; esgotado, `503` (HTTP) ou mensagem devolvida com backoff (SQS).
- **Violação de unicidade:** rollback e reexecução; na volta, o caminho rápido encontra a linha ⇒ replay ou 409.
- **Determinístico (lista fechada):** erro de domínio inesperado, dados inválidos (`22xxx`, ex. overflow), integridade exceto unicidade (`23xxx`), trigger (`P0001`). ⇒ grava `FAILED` numa transação separada e responde `422 FAILED` / envia à DLQ.

Inverter o padrão (tratar o desconhecido como permanente) transformaria um `statement_timeout` ou um Postgres reiniciando em `FAILED` definitivo — e o redrive nunca mais conseguiria processar.

---

## 7. Idempotência

- **Chave:** `Idempotency-Key`, única **por provedor** (`UNIQUE (provider_id, idempotency_key)`); também `UNIQUE (provider_id, external_transaction_id)`.
- **`payloadHash`** = SHA-256 do JSON canônico (chaves ordenadas recursivamente, sem espaços, nulos omitidos) de `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, `referenceExternalTransactionId`. A key e metadados de transporte ficam de fora.
- **Mesma key + mesmo hash** ⇒ replay, com a resposta montada só com dados gravados (inclusive o **saldo observado naquele momento**). **Mesma key + hash diferente** ⇒ 409 sem revelar o original.
- **HTTP e SQS compartilham a idempotência:** a mesma operação pelos dois canais tem um único efeito (testado com 50 envios, metade por cada canal, em 3 instâncias).
- **Toda rejeição de negócio é gravada**, para que o reenvio dê sempre o mesmo resultado — inclusive `WALLET_NOT_FOUND` continua assim mesmo depois que a wallet é criada.

---

## 8. Mensageria: inbox, outbox, consumer, DLQ

### Inbox

`PK (consumer_name, message_id)` com o `messageId` **do corpo** (sobrevive ao redrive). Hash da inbox = SHA-256 do JSON canônico de `type` + `data` (sem `occurredAt`: um reenvio legítimo do produtor não vira conflito). Inserção com `ON CONFLICT DO NOTHING` na mesma transação do processamento.

### Consumer SQS

- Long polling de 20 s, lotes de até 10, grupos diferentes em paralelo e mensagens do mesmo grupo em sequência; visibilidade de 30 s com heartbeat a cada 10 s.
- Ação por classe de erro: ver a tabela do [README](README.md#5-usando-a-fila-sqs). Envio à DLQ usa **`MessageDeduplicationId` novo** (o FIFO descartaria em silêncio um id repetido dentro de 5 minutos) e o mesmo grupo, e só depois apaga a original.
- Transitório: `ChangeMessageVisibility(min(15 × 2^(entrega−1), 300) s)`; com `maxReceiveCount = 8`, ≈ 23 minutos de tolerância antes da DLQ. Nenhum `FAILED` é gravado nesse caminho, então o redrive depois do incidente processa normalmente.

### Outbox

- Eventos gravados **na mesma transação** do efeito; o relay só enxerga o que foi confirmado (testado com uma transação mantida aberta).
- Relay com **lease** (`locked_until`/`locked_by`, 30 s) e `FOR UPDATE SKIP LOCKED`: várias instâncias publicam em paralelo sem pegar o mesmo evento; se uma morrer depois de publicar e antes de marcar, outra republica depois do lease (mesmo `eventId`, mesmos bytes — o corpo é o `payload::text` gravado, sem re-serializar).
- A outbox **nunca desiste**: falha ⇒ retry com backoff (base 1 s, teto 300 s) e `last_error`; o atraso aparece em `outbox_lag_seconds`.
- Entrega **pelo menos uma vez**; o consumidor deduplica por `eventId`.

#### Ordem dos eventos — opções avaliadas

O desafio não exige ordem, mas ela é desejável para quem consome `WalletBalanceChanged`.

| Opção                                                                                       | A favor                                                                              | Contra                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordenar por `occurred_at`                                                                   | simples                                                                              | usa o relógio de cada instância: com 3 instâncias, dois eventos da mesma wallet podem se inverter; um evento em retry é ultrapassado                                                                                      |
| **Ordem estrita por wallet** (o relay só publica o primeiro evento pendente de cada wallet) | ordem garantida mesmo sob falha                                                      | **bloqueio na cabeça da fila:** um evento que o SQS rejeita para sempre trava a wallet inteira; uma wallet com muitos eventos escoa um por ciclo; contornar exige mais mecanismos (estacionar eventos, reserva em blocos) |
| **Ordem de commit sem bloqueio** (escolhida)                                                | ordem correta no caminho normal, independente de relógio; nenhum evento segura outro | sob falha, um evento atrasado pode chegar depois dos seguintes                                                                                                                                                            |

**Como funciona:** cada linha da outbox recebe uma `seq` (`GENERATED ALWAYS AS IDENTITY`) no INSERT, que acontece sob o lock da wallet — ou seja, na ordem de commit. O relay reserva em ordem de `seq` e publica os eventos de cada wallet em sequência (wallets diferentes em paralelo); `MessageGroupId = walletId` preserva essa ordem no FIFO.

**Por quê:** atende a tudo que o desafio exige sem acrescentar riscos. A ordem estrita foi implementada, testada e **revertida**: trocava um problema raro que o consumidor já resolve (evento fora de ordem sob falha — ele deduplica por `eventId` e aplica saldo pela `walletVersion`) por dois riscos operacionais piores (uma wallet parada por um evento envenenado; uma fila grande escoando devagar).

### Desligamento gracioso — opções avaliadas

| Opção                                                                                                                                                       | Contra                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Sequencial: para o consumer e depois fecha o HTTP                                                                                                           | o readiness nunca chega a responder 503 (passa direto a "conexão recusada") e o pior caso soma os dois tempos |
| **Paralela** (escolhida): readiness 503 → drena consumer e requisições HTTP ao mesmo tempo, com o listener ainda aceitando → fecha listener e pool → exit 0 | um pouco mais de código (contador de requisições em andamento)                                                |

Uma mensagem SQS que passar do prazo de 20 s tem a transação **cancelada antes** de a mensagem voltar à fila (senão a transação seguiria segurando a linha da inbox enquanto outra instância recebe a mensagem). Testado: a requisição em andamento recebe 200, uma requisição nova durante a drenagem é atendida, o processo sai com 0.

---

## 9. Taxonomia de falhas

Toda rejeição carrega um `failureCode` estável. "Corrigir" significa enviar como **nova** transação (novo id externo e nova key): o original já tem resultado terminal gravado, e reenviá-lo devolve o mesmo resultado.

| `failureCode`                 | Status   | Quando                                                                                                             | Ação do provedor                              |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `INSUFFICIENT_BALANCE`        | REJECTED | `BET` sem saldo                                                                                                    | desistir                                      |
| `REVERSAL_WOULD_OVERDRAW`     | REJECTED | `ROLLBACK` de `WIN`/`REFUND` deixaria o saldo negativo                                                             | escalar para a operação                       |
| `CURRENCY_MISMATCH`           | REJECTED | moeda diferente da wallet                                                                                          | corrigir                                      |
| `WALLET_NOT_FOUND`            | REJECTED | wallet inexistente                                                                                                 | corrigir                                      |
| `PLAYER_WALLET_MISMATCH`      | REJECTED | `playerId` não é o dono da wallet (o saldo **não** é revelado)                                                     | corrigir                                      |
| `UNKNOWN_PROVIDER`            | REJECTED | provedor desconhecido ou inativo                                                                                   | contatar o operador                           |
| `REFERENCE_REQUIRED`          | REJECTED | `REFUND`/`ROLLBACK` sem referência                                                                                 | corrigir                                      |
| `REFERENCE_NOT_FOUND`         | REJECTED | a referência não chegou dentro do prazo                                                                            | investigar                                    |
| `REFERENCE_MISMATCH`          | REJECTED | referência de outro provider, player, wallet, moeda ou rodada                                                      | corrigir                                      |
| `INVALID_REFERENCE_KIND`      | REJECTED | `REFUND` de não-`BET`; `ROLLBACK` de `LOSS`/`ROLLBACK`; `WIN`/`LOSS` referenciando não-`BET`; `BET` com referência | corrigir                                      |
| `REFERENCE_AMOUNT_MISMATCH`   | REJECTED | valor diferente do da referência (reversão parcial fora de escopo)                                                 | corrigir                                      |
| `REFERENCE_NOT_PROCESSED`     | REJECTED | a referência existe, mas foi rejeitada ou falhou                                                                   | desistir                                      |
| `ALREADY_REVERSED`            | REJECTED | a referência já foi revertida; ou `WIN` de uma `BET` revertida                                                     | desistir                                      |
| `BET_ALREADY_SETTLED`         | REJECTED | reversão de `BET` que tem `WIN` processado e vigente                                                               | fazer `ROLLBACK` do `WIN` antes               |
| `OPENING_NOT_ALLOWED`         | REJECTED | `OPENING` enviado por API ou fila                                                                                  | corrigir                                      |
| `UNEXPECTED_PROCESSING_ERROR` | FAILED   | payload válido disparou um erro inesperado; **nada foi aplicado**                                                  | não reenviar a mesma key; contatar o operador |

Saldo insuficiente numa aposta e reversão que estouraria o saldo têm códigos **distintos** porque exigem ações diferentes (desistir × escalar).

---

## 10. Referências fora de ordem

- Referência ausente ⇒ a transação é gravada como `PENDING_REFERENCE` (com o saldo observado), responde `202` e gera `WagerTransactionPendingReference`. **O reenvio nunca resolve uma pendente** — devolve o replay `202`.
- **Worker** (em todas as instâncias): reserva as pendentes vencidas com lease de 30 s (`SKIP LOCKED`) numa transação curta; resolve cada uma numa transação própria, pelo **mesmo núcleo** do processamento normal: trava a wallet → relê → **primeiro tenta resolver** → se a referência continua ausente e o prazo venceu, `REJECTED REFERENCE_NOT_FOUND` + evento; senão, reagenda com backoff (base 1 s, teto 300 s).
- **Aceleração:** quando a referência chega, as pendentes que esperam por ela têm a próxima tentativa antecipada para agora — resolução em menos de 2 s no teste.
- **TTL de 24 h** (configurável): cobre atrasos realistas de provedores e reprocessamentos de fila no mesmo dia, sem deixar pendências indefinidas. Uma referência que chega depois do prazo, mas antes de o worker rodar, ainda resolve a pendente (ele tenta resolver antes de checar o prazo).
- Cadeias funcionam: `ROLLBACK` de um `REFUND` que espera a `BET` — as três se resolvem em sequência.

---

## 11. API HTTP e autenticação

- Status e códigos: uma tabela única para todos os endpoints (ver [README](README.md#6-códigos-de-status-http)). Distingue payload inválido (400), conflito de idempotência (409), rejeição de negócio (422 `REJECTED`), aceite pendente (202) e falha transitória (503 + `Retry-After`) — o provedor decide se reenvia sem interpretar mensagem.
- Validação com Zod, schemas estritos (campo extra = 400), os mesmos schemas geram o OpenAPI (`/docs-json`) e validam as mensagens SQS.
- **Autenticação real com Keycloak** (`client_credentials`), um client por provedor e um de operador. A guarda é genérica (OIDC via JWKS, `jose`): troca de provedor de identidade é só configuração. JWKS em cache: com o Keycloak fora do ar, tokens válidos continuam aceitos; o Keycloak **não** entra no readiness. JWKS inacessível ⇒ 503 (o provedor pode reenviar) e métrica.
- **Regras de acesso:** a identidade do provedor vem do token (`azp`); `providerId` divergente ⇒ 403 e nada gravado; transação de outro provedor buscada pelo id ⇒ 404 (não revela que existe). O provedor **não** lê wallets nem ledger — a wallet é compartilhada entre provedores; ele vê o saldo apenas na resposta das próprias transações. Quem cria wallets é o operador.
- A fila SQS é um canal interno confiável, sem token; o `providerId` da mensagem passa pelas mesmas validações.

---

## 12. Interpretações das regras de negócio

| Tema                          | Interpretação                                                                                                                                     | Por quê                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rodada                        | `roundId` é só um atributo; não há ciclo de vida (aberta/fechada). Vários `BET`/`WIN` por rodada e `WIN` depois de `LOSS` são aceitos             | quem conhece as regras do jogo é o provedor (rodadas grátis, jackpots, várias apostas por rodada); fechar rodada rejeitaria pagamentos devidos e quebraria com mensagens fora de ordem. A rodada só é usada para validar referências |
| `WIN`                         | referência **opcional**; se presente, precisa ser a `BET` da mesma rodada, e vira pendente se ainda não chegou                                    | o enunciado diz que o `WIN` "pode" referenciar a `BET`                                                                                                                                                                               |
| Reversões                     | uma transação é revertida **uma única vez, por qualquer tipo** (`REFUND` ou `ROLLBACK`) — índice único parcial no banco                           | ao pé da letra ("pelo mesmo tipo") permitiria `BET -10 → REFUND +10 → ROLLBACK(BET) +10`: devolução em dobro                                                                                                                         |
| Reversão desfeita             | `ROLLBACK` de um `REFUND` é permitido (desfaz a devolução), mas a `BET` continua marcada como já revertida                                        | evita ciclos de reversão; o índice único continua valendo                                                                                                                                                                            |
| `WIN` de `BET` revertida      | `ALREADY_REVERSED` (só conta reversão vigente)                                                                                                    | pagaria devolução **e** prêmio                                                                                                                                                                                                       |
| Reversão de `BET` já premiada | `BET_ALREADY_SETTLED` enquanto houver `WIN` referenciado vigente — duas barreiras: regra e trigger                                                | sem isso, `WIN` seguido de `REFUND` pagaria as duas coisas; o caminho legítimo é `ROLLBACK` do `WIN` primeiro                                                                                                                        |
| Valor zero                    | `WIN`, `LOSS` e `ROLLBACK` aceitam `"0.00"` sem efeito no saldo (sem lançamento, sem mudar a versão); `BET`, `REFUND` e saldo inicial exigem > 0  | `LOSS 0.00` e `WIN 0.00` são comuns no mercado; apostas grátis ficam fora de escopo                                                                                                                                                  |
| `OPENING`                     | transação interna com `provider_id = 'internal'`, sem rodada/jogo; não pode ser enviada por API/fila; `providerId = "internal"` é reservado (400) | o saldo inicial também fica no ledger e é auditável                                                                                                                                                                                  |
| Saldo em rejeição             | a rejeição grava o saldo observado; em `PLAYER_WALLET_MISMATCH` grava `null`                                                                      | o provedor não pode ver o saldo da wallet de outro jogador                                                                                                                                                                           |
| Reconciliação                 | `difference = stored − calculated`; também acusa corrente quebrada (`chainIntact`, `firstBrokenVersion`)                                          | detecta adulteração ou lançamento faltante, não só diferença de soma                                                                                                                                                                 |

---

## 13. Observabilidade

- **Logs** JSON (pino) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, tipo, status, `failureCode` e duração; uma linha por requisição HTTP e por comando processado. **Redação automática** de valores, saldos, `playerId`, tokens e corpos — mesmo se logados por engano (testado).
- **Métricas Prometheus** numa porta interna (9464), separada da API. Cobrem o que o desafio pede (transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência) e o "por que está lento" sem tracing: espera pelo lock da wallet, duração de cada transação, duração de cada publicação. `dlq_depth` é lido da própria DLQ a cada 15 s (conta também o que o SQS move sozinho). Métricas nunca somam dinheiro.
- **Health:** `/health/live` sem dependências; `/health/ready` com PostgreSQL e SQS (timeout de 3 s) e 503 durante o desligamento.
- **Correlação:** `X-Correlation-Id` (aceito do cliente ou gerado) e `X-Instance-Id` em toda resposta; o `correlationId` segue nos eventos publicados.

---

## 14. Estratégia de testes

- **Unitários:** domínio, regras (um teste por `failureCode` e pela ordem de precedência), `Money` (com testes de propriedade), hash canônico, classificação de erros, regras de lint (dinheiro como `number` e imports no domínio são erros de lint, testados).
- **Integração com PostgreSQL e SQS reais** (Testcontainers): constraints e triggers um a um, privilégios, migrations, repositórios, ordem de escrita, runner (lock, timeouts, retries, cancelamento), casos de uso, atomicidade, API completa (tabela de status inteira), consumer (dedupe, DLQ, backoff, esgotamento, redrive, shutdown), outbox (vários relays, morte antes de marcar, SQS pausado), worker, Keycloak real, logs e métricas.
- **Concorrência real:** conexões paralelas no mesmo processo e **3 processos Bun da aplicação** sobre os mesmos containers — os 8 cenários do desafio, fila _standard_, caos com todos os tipos e reversões fora de ordem (delta de deadlocks = 0), `kill -9` no meio da carga e `SIGTERM` com requisição em andamento. Cenários críticos repetidos 20× na CI.
- **Invariante final** em todo teste de integração e concorrência: saldo = soma do ledger, corrente de versões íntegra, toda transação que move saldo tem exatamente um lançamento.
- **Sem `sleep`:** esperas por condição (`waitUntil`) e relógio controlado nos testes de prazo.
- **Cobertura com limites na CI** (`src` ≥ 90%, domínio ≥ 95%, cada arquivo ≥ 80%, nenhum arquivo fora do relatório). Atual: ~98,6% das linhas de `src`, 100% do domínio.
- Testes escritos antes do código na maior parte do projeto; onde não foi assim (camada HTTP), mutações deliberadas confirmaram que os testes pegam regressões.

---

## 15. Limitações e trade-offs conhecidos

- **Vazão por wallet:** uma operação por vez em cada wallet (custo do lock pessimista). Wallets diferentes escalam em paralelo; particionar ou bufferizar uma wallet muito disputada fica fora de escopo.
- **`WIN` sem referência** não aponta para nenhuma `BET`; as regras de "aposta revertida" e "aposta já premiada" não o alcançam (consequência de a rodada não ter ciclo de vida).
- **Ordem dos eventos sob falha:** um evento em retry pode chegar depois dos seguintes da mesma wallet (seção 8). Um evento que o SQS rejeita para sempre fica em retry (teto de 5 min), visível em `outbox_lag_seconds` e `last_error`, sem bloquear os demais.
- **Sem limpeza de inbox e outbox:** as tabelas crescem; em produção, uma rotina removeria inbox antiga (além da janela de redrive) e outbox publicada (após o período de auditoria).
- **Escala 2 fixa** para todas as moedas; moedas com 0 ou 3 casas exigiriam escala por moeda.
- **Apostas grátis** (`BET 0.00`) e **reversão parcial** estão fora de escopo.
- **nginx open source não consulta o readiness:** retira instâncias de forma passiva (`max_fails`/`fail_timeout`); durante um desligamento, continua enviando requisições, que são atendidas, mas podem alongar a drenagem até 20 s.
- **Ledger de entrada simples** (ver seção 16).
- **Ambiente local:** MiniStack no lugar do SQS (sem `StartMessageMoveTask`, por isso o redrive é um script); segredos do Keycloak fixos no realm versionado.

---

## 16. Avaliado e não implementado

- **Partidas dobradas.** Cada transação geraria também uma contrapartida numa conta da casa (por provedor e moeda), e a soma global seria zero. **Não implementado** porque, no desenho ingênuo (saldo da casa materializado e atualizado com lock), a conta da casa vira um **lock global** por provedor — exatamente o que o desafio proíbe — e derruba o paralelismo. Se adotado, o desenho correto seria: contas da casa só com lançamentos _append-only_ (saldo calculado por soma, sem lock), apenas a wallet do jogador com saldo travado, e um constraint trigger `DEFERRABLE INITIALLY DEFERRED` exigindo um lançamento de cada lado por transação. Precisa entrar desde o schema inicial.
- **OpenTelemetry.** Daria a árvore de spans por requisição; no Bun, a auto-instrumentação ainda é imatura (sem preload, HTTP e AWS SDK sem garantia), o que exigiria spans manuais em todo o código. As métricas de tempo por etapa e o `correlationId` cobrem o diagnóstico principal.
- **Ordem estrita de eventos por wallet** e **estacionamento de eventos envenenados** — avaliados e revertidos (seção 8).
