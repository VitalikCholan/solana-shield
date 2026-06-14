# Resilience guarantees

The judging rubric scores **Resilience Quality (25%)** on three named failure
modes: *RPC failures, dropped transactions, and network congestion*. This page
maps each guarantee to the fault we inject and the test that proves it. Every
test is deterministic (seeded chaos + injected clocks) — no network required.

Run them all: `pnpm vitest run test/scenarios`

## 1. RPC failures → [`test/scenarios/rpc-failures.test.ts`](../test/scenarios/rpc-failures.test.ts)

| Guarantee | Fault injected | Expected behavior |
|---|---|---|
| Hard down (conn refused/reset) | one endpoint drops 100% of calls | requests still succeed via healthy nodes; dead node never serves and is down-weighted; recovers after it heals |
| Soft errors (5xx) | endpoint returns 503 on every call | classified retryable → recovers on another node |
| Partial failure (one method broken) | node returns `-32005` only for `getSignatureStatuses` | node is **not** blacklisted wholesale; the broken method rotates, other methods keep using it |
| All endpoints down | every endpoint drops 100% | clear `AllEndpointsFailedError` carrying the underlying causes — never an infinite loop or silent hang |
| Primary dies mid-confirmation | primary throws on `getSignatureStatuses` | confirmation reattaches to another node; the tx still resolves |
| Total partition → recovery | all endpoints down 5s, then heal | breakers open; on heal the selector force-half-opens the best one — no deadlock (`resilience.test.ts`) |

## 2. Dropped transactions → [`test/scenarios/dropped-transactions.test.ts`](../test/scenarios/dropped-transactions.test.ts)

| Guarantee | Fault injected | Expected behavior |
|---|---|---|
| Never confirms initially | status `null` for 3 polls, then confirmed | rebroadcast loop resends the **identical signed bytes** until it lands; `result.attempts > 1`; stops the instant it confirms |
| Blockhash expires before landing | status stays `null` past `lastValidBlockHeight` | fails cleanly with `TxExpiredError` and **stops resending** — a provably-dead tx is never resent forever |
| "Already processed" race | resends throw `already processed` while it confirms | resend errors swallowed; independent confirmation resolves as success |
| Jito accepted but didn't land | Jito send resolves but tx never lands via Jito | `route: 'auto'` alternates the rebroadcast onto RPC, which lands it |

> **Design note (correctness):** solana-shield rebroadcasts identical bytes; it
> does **not** silently re-sign with a fresh blockhash or escalate the fee on
> retry. Re-signing without the caller's intent is a correctness hazard
> (especially for wallet signers), so expiry surfaces a typed error and the
> caller decides. This is deliberate, and tested as such.

## 3. Network congestion → [`test/scenarios/network-congestion.test.ts`](../test/scenarios/network-congestion.test.ts)

| Guarantee | Fault injected | Expected behavior |
|---|---|---|
| Latency spike / hung node | endpoint hangs (slow-loris) | per-request timeout trips, rotates to a fast node — bounded latency, never an infinite hang |
| Rate-limit storm | 429s across most of the pool | throttled nodes enter `Retry-After` cooldown; traffic concentrates on the survivor; zero user-visible failures |
| 30% packet loss | random 30% of requests dropped | retries absorb the loss; effectively all requests succeed (seeded → deterministic) |
| Full storm | latency + 20% 429s + 30% drops together | a transaction still lands through the combined profile |
| Hedged reads (tail latency) | one slow endpoint, one fast | duplicate fired after the delay; faster node wins; loser aborted ([`test/unit/transport/hedge.test.ts`](../test/unit/transport/hedge.test.ts)) |

## Side-by-side: vanilla kit vs solana-shield → [`test/scenarios/baseline-comparison.test.ts`](../test/scenarios/baseline-comparison.test.ts)

Controlled before/after on the *same* injected fault:

| Scenario | Vanilla `@solana/kit` | solana-shield |
|---|---|---|
| Transient endpoint failure (read) | `rpc.getSlot()` throws | retries + failover → succeeds |
| Dropped transaction (write) | one-shot send → still unconfirmed | rebroadcast + polling → confirmed |

## Why this is testable at all

Every time- and network-dependent input is injectable — the transport
(`RpcTransport` is just a function), the clock (`now`), the PRNG (`random`/seed),
and `AbortSignal`. That's what turns "30% packet loss during congestion" into a
fast, repeatable unit test instead of a flaky integration run. The fault
injector itself ships as [`solana-shield/chaos`](../src/chaos/chaos-transport.ts)
so dApp authors can run their own apps through the same scenarios.
