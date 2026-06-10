/**
 * Headless demo: send a self-transfer on devnet through the full solana-shield
 * pipeline and stream every lifecycle event to the console.
 *
 * Run:  npx tsx examples/node-send.ts
 * Env:  SHIELD_ENDPOINTS  comma-separated RPC URLs (default: devnet)
 *       SHIELD_KEYPAIR    path to a JSON keypair file (default: generate + airdrop)
 */
import { readFileSync } from 'node:fs';
import { airdropFactory, createKeyPairSignerFromBytes, createSolanaRpc, createSolanaRpcSubscriptions, generateKeyPairSigner, lamports } from '@solana/kit';
import { createShield, transferInstruction } from '../src/index.js';

const endpoints = (process.env['SHIELD_ENDPOINTS'] ?? 'devnet').split(',').map(s => s.trim());

async function loadSigner() {
  const path = process.env['SHIELD_KEYPAIR'];
  if (path) {
    const bytes = new Uint8Array(JSON.parse(readFileSync(path, 'utf8')) as number[]);
    return createKeyPairSignerFromBytes(bytes);
  }
  const signer = await generateKeyPairSigner();
  console.log(`Generated throwaway signer ${signer.address} — requesting devnet airdrop...`);
  const rpc = createSolanaRpc('https://api.devnet.solana.com');
  const rpcSubscriptions = createSolanaRpcSubscriptions('wss://api.devnet.solana.com');
  await airdropFactory({ rpc, rpcSubscriptions })({
    commitment: 'confirmed',
    lamports: lamports(1_000_000_000n),
    recipientAddress: signer.address,
  });
  return signer;
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
  console.log(`✅ confirmed in slot ${confirmed.slot} via ${confirmed.confirmedVia}`);
  console.log(`   https://explorer.solana.com/tx/${confirmed.signature}?cluster=devnet`);
} catch (err) {
  console.error('❌', err);
  process.exitCode = 1;
} finally {
  shield.destroy();
}
