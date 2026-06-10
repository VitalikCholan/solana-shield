# Jito / MEV routing in solana-shield

solana-shield submits frontrun-sensitive transactions through [Jito block
engines](https://docs.jito.wtf/lowlatencytxnsend/) instead of the public
mempool path, with automatic fallback to regular RPC broadcast.

## Enabling

```ts
const shield = createShield({
  endpoints: [...],
  jito: {
    regions: ['frankfurt', 'amsterdam'],  // tried in order; omit for the global endpoint
    authUuid: process.env.JITO_UUID,      // optional — Jito works unauthenticated
  },
});
```

## Routing policies (`sendReliably({ route })`)

| Policy | Behavior | Use when |
|---|---|---|
| `'auto'` *(default)* | First broadcast via Jito; on failure/timeout, fall back to RPC with a `jitoFallback` event. Rebroadcasts alternate Jito/RPC so a black-holing region can't absorb every resend. | You want protection *and* landing reliability. |
| `'jito'` | Strict. Jito failures reject the send; sending-only wallet signers are rejected upfront. A frontrun-protected transaction is **never** silently downgraded to the public mempool. | The transaction must not be publicly visible pre-inclusion (e.g. large swaps). |
| `'rpc'` | Jito never touched. | Devnet, or txs with no MEV exposure. |

## Mechanics

- **Endpoint**: `POST https://{region}.mainnet.block-engine.jito.wtf/api/v1/transactions`
  (JSON-RPC `sendTransaction`, base64). Bundles (1–5 atomic txs) via
  `sendBundle` on `/api/v1/bundles`; `JitoSender.getBundleStatuses` polls landing.
- **Tip**: a SystemProgram transfer appended as the *last* instruction, to one
  of the 8 canonical tip accounts chosen at random (reduces write-lock
  contention). Size = `max(1000 lamports, live tip-floor p50)` from
  `bundles.jito.wtf/api/v1/bundles/tip_floor`, cached 10s. Override with
  `jitoTipLamports`.
- **Rate compliance**: Jito's default limit is 1 req/s per IP per region. Each
  region has its own token bucket; a saturated region is *skipped* (next region
  tried immediately) rather than provoking a 429 — unless it's the only region,
  in which case the sender waits for the token.
- **Regional failover**: regions are tried in configured order with a 2s
  timeout each; HTTP errors, JSON-RPC errors, and timeouts rotate to the next.
- **"Accepted but didn't land"**: acceptance by a block engine is not
  inclusion. The pipeline treats Jito acceptance identically to an RPC send —
  the rebroadcast loop keeps re-submitting the identical signed bytes every
  2.5s (alternating routes under `'auto'`) until WS/poll confirmation or
  blockhash expiry. There is no separate "Jito landed?" check to get wrong.
- **Wallets**: Jito requires owning the signed bytes. Wallets exposing
  `solana:signTransaction` work fully; sign-and-send-only wallets degrade to
  RPC with an explicit `jitoFallback { reason: 'signerCannotExportBytes' }`.

## Verifying

- Unit + scenario tests: `test/unit/jito/sender.test.ts` (regions, tips,
  buckets, bundles), `test/unit/tx/pipeline.test.ts` (routing policies,
  fallback events, strict mode).
- Manual smoke test (mainnet, dust amount):
  `SHIELD_ENDPOINTS=<mainnet-rpc> npx tsx examples/node-send.ts` with
  `jito: { regions: [...] }` enabled in the example config.

> **Devnet note:** Jito block engines serve mainnet. On devnet, configure
> `route: 'rpc'` (or simply omit `jito` from the config) — the rest of the
> pipeline is identical, which is what makes the routing logic testable
> against mocks without a mainnet dependency.
