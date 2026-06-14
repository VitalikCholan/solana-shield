/**
 * Headless demo: send a self-transfer through the full solana-shield pipeline
 * and stream every lifecycle event to the console.
 *
 * Works against any cluster — devnet, a local solana-test-validator, or Surfpool:
 *
 *   npx tsx examples/node-send.ts                              # devnet (default)
 *   SHIELD_ENDPOINTS=localnet npx tsx examples/node-send.ts    # local validator / surfpool
 *   SHIELD_ENDPOINTS=localnet SHIELD_KEYPAIR=./dev-key.json npx tsx examples/node-send.ts
 *
 * Env:  SHIELD_ENDPOINTS  comma-separated RPC URLs or monikers (default: devnet)
 *       SHIELD_KEYPAIR    path to a JSON keypair file; skips the airdrop when set
 */
import { readFileSync } from 'node:fs';
import type { Address } from '@solana/kit';
import {
  airdropFactory,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  generateKeyPairSigner,
  lamports,
} from '@solana/kit';
import { createShield, resolveEndpoints, transferInstruction } from '../src/index.js';

const endpoints = (process.env['SHIELD_ENDPOINTS'] ?? 'devnet').split(',').map(s => s.trim());
const primary = resolveEndpoints(endpoints)[0]!; // first endpoint drives the airdrop + explorer link

/** Airdrop against the *configured* cluster (not hardcoded devnet), with retries
 *  so a transient public-faucet hiccup doesn't sink the demo. Local validators
 *  and Surfpool answer instantly and reliably. */
async function airdrop(recipient: Address) {
  const rpc = createSolanaRpc(primary.url);
  const rpcSubscriptions = createSolanaRpcSubscriptions(primary.wsUrl);
  const requestAirdrop = airdropFactory({ rpc, rpcSubscriptions });
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await requestAirdrop({ commitment: 'confirmed', lamports: lamports(1_000_000_000n), recipientAddress: recipient });
      return;
    } catch (err) {
      lastErr = err;
      console.log(`  airdrop attempt ${attempt} failed, retrying...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

async function loadSigner() {
  const path = process.env['SHIELD_KEYPAIR'];
  if (path) {
    const bytes = new Uint8Array(JSON.parse(readFileSync(path, 'utf8')) as number[]);
    return createKeyPairSignerFromBytes(bytes);
  }
  const signer = await generateKeyPairSigner();
  console.log(`Generated throwaway signer ${signer.address} — airdropping via ${primary.url} ...`);
  await airdrop(signer.address);
  return signer;
}

function explorerLink(signature: string): string {
  const url = primary.url;
  if (url.includes('devnet')) return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
  if (url.includes('testnet')) return `https://explorer.solana.com/tx/${signature}?cluster=testnet`;
  if (url.includes('127.0.0.1') || url.includes('localhost')) {
    return `https://explorer.solana.com/tx/${signature}?cluster=custom&customUrl=${encodeURIComponent(url)}`;
  }
  return `https://explorer.solana.com/tx/${signature}`;
}

const shield = createShield({
  endpoints,
  // Uncomment to route through Jito on mainnet:
  // jito: { regions: ['frankfurt', 'amsterdam'] },
});

const signer = await loadSigner();
console.log(`Sending 1000 lamports ${signer.address} → self via ${endpoints.join(', ')}`);

const handle = shield.sendReliably({
  instructions: [transferInstruction(signer.address, signer.address, 1000n)],
  signer,
});

for await (const event of handle) {
  console.log(`[${new Date().toISOString()}]`, JSON.stringify(event, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  ));
}

try {
  const confirmed = await handle.result;
  console.log(
    `✅ confirmed in slot ${confirmed.slot} via ${confirmed.confirmedVia} ` +
      `(route ${confirmed.route}, ${confirmed.attempts} broadcast(s), ${confirmed.durationMs}ms)`,
  );
  console.log(`   ${explorerLink(confirmed.signature)}`);
} catch (err) {
  console.error('❌', err);
  process.exitCode = 1;
} finally {
  shield.destroy();
}
