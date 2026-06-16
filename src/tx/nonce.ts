import type { Address, GetAccountInfoApi, Nonce, Rpc } from '@solana/kit';
import { getBase58Decoder } from '@solana/kit';

/**
 * Read the current durable-nonce value out of a SystemProgram nonce account.
 *
 * Nonce account layout (v1, 80 bytes): version u32 · state u32 · authority [32]
 * · **durable nonce [32] @ offset 40** · feeCalculator u64. The nonce value is
 * the base58 of bytes 40..72 — the "blockhash" a durable-nonce transaction
 * pins its lifetime to.
 */
export async function fetchNonceValue(
  rpc: Rpc<GetAccountInfoApi>,
  nonceAccount: Address,
  signal?: AbortSignal,
): Promise<Nonce> {
  const { value } = await rpc
    .getAccountInfo(nonceAccount, { encoding: 'base64' })
    .send(signal ? { abortSignal: signal } : undefined);
  if (!value) {
    throw new Error(`Nonce account ${nonceAccount} not found`);
  }
  const [base64] = value.data as readonly [string, string];
  // atob is browser-safe and present in Node >= 16 — keeps the core dependency-free.
  const binary = atob(base64);
  if (binary.length < 72) {
    throw new Error(
      `Account ${nonceAccount} is not an initialized nonce account (${binary.length} bytes)`,
    );
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = binary.charCodeAt(40 + i);
  return getBase58Decoder().decode(bytes) as Nonce;
}
