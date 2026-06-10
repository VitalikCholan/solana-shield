import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { Address, SignatureBytes, Transaction, TransactionSendingSigner } from '@solana/kit';
import { getTransactionEncoder } from '@solana/kit';

/**
 * Dependency-free wallet-standard integration.
 *
 * Implements the two-sided wallet-standard discovery handshake directly
 * (`wallet-standard:app-ready` / `wallet-standard:register-wallet` window
 * events), so the SDK needs no runtime dependency on `@wallet-standard/app`.
 * React apps that already use `@solana/react` can skip this module entirely
 * and pass `useWalletAccountTransactionSendingSigner(...)`'s signer straight
 * into `shield.sendReliably`.
 */

interface RegisterApi {
  register(...wallets: Wallet[]): () => void;
}

type RegisterWalletCallback = (api: RegisterApi) => void;

const registered = new Set<Wallet>();
const listeners = new Set<(wallets: readonly Wallet[]) => void>();
let discoveryStarted = false;

function notify(): void {
  const snapshot = getDiscoveredWallets();
  for (const listener of listeners) listener(snapshot);
}

const registerApi: RegisterApi = {
  register(...wallets: Wallet[]) {
    for (const wallet of wallets) registered.add(wallet);
    notify();
    return () => {
      for (const wallet of wallets) registered.delete(wallet);
      notify();
    };
  },
};

function startDiscovery(): void {
  if (discoveryStarted || typeof window === 'undefined') return;
  discoveryStarted = true;
  // Wallets that load after us announce themselves with this event.
  window.addEventListener('wallet-standard:register-wallet', event => {
    const callback = (event as CustomEvent<RegisterWalletCallback>).detail;
    if (typeof callback === 'function') callback(registerApi);
  });
  // Wallets already present listen for the app-ready announcement.
  try {
    window.dispatchEvent(
      new CustomEvent<RegisterApi>('wallet-standard:app-ready', { detail: registerApi }),
    );
  } catch {
    // Some environments restrict synthetic events; discovery degrades gracefully.
  }
}

/** Snapshot of wallets discovered so far (starts discovery on first call). */
export function getDiscoveredWallets(): readonly Wallet[] {
  startDiscovery();
  return [...registered];
}

/**
 * Watch wallet registrations; fires immediately with the current snapshot.
 * Returns an unsubscribe function.
 */
export function watchWallets(onChange: (wallets: readonly Wallet[]) => void): () => void {
  startDiscovery();
  listeners.add(onChange);
  onChange(getDiscoveredWallets());
  return () => {
    listeners.delete(onChange);
  };
}

const SIGN_AND_SEND_FEATURE = 'solana:signAndSendTransaction';

interface SignAndSendFeature {
  signAndSendTransaction(
    ...inputs: Array<{
      readonly account: WalletAccount;
      readonly chain: string;
      readonly transaction: Uint8Array;
    }>
  ): Promise<ReadonlyArray<{ readonly signature: Uint8Array }>>;
}

export interface CreateSignerOptions {
  /** Chain to submit on (default: the account's first `solana:` chain). */
  readonly chain?: string;
}

/**
 * Adapt a wallet-standard account into a kit `TransactionSendingSigner`,
 * ready for `shield.sendReliably({ signer, ... })`.
 *
 * Note: a sending signer signs AND submits in the wallet, so solana-shield
 * cannot export the signed bytes — `sendReliably` automatically degrades the
 * route to RPC (emitting an explicit `jitoFallback` event) and still owns
 * confirmation, expiry tracking, and status events.
 */
export function createSignerFromWalletAccount(
  wallet: Wallet,
  account: WalletAccount,
  options: CreateSignerOptions = {},
): TransactionSendingSigner {
  const feature = wallet.features[SIGN_AND_SEND_FEATURE] as SignAndSendFeature | undefined;
  if (!feature || typeof feature.signAndSendTransaction !== 'function') {
    throw new Error(
      `Wallet "${wallet.name}" does not support ${SIGN_AND_SEND_FEATURE}. ` +
        `Available features: ${Object.keys(wallet.features).join(', ')}`,
    );
  }
  const chain =
    options.chain ?? account.chains.find(c => c.startsWith('solana:')) ?? 'solana:mainnet';
  const encoder = getTransactionEncoder();

  return {
    address: account.address as Address,
    async signAndSendTransactions(
      transactions: readonly Transaction[],
    ): Promise<readonly SignatureBytes[]> {
      const outputs = await feature.signAndSendTransaction(
        ...transactions.map(transaction => ({
          account,
          chain,
          transaction: new Uint8Array(encoder.encode(transaction)),
        })),
      );
      return outputs.map(o => o.signature as SignatureBytes);
    },
  };
}

/** Wallets exposing `solana:signAndSendTransaction` (i.e. usable with this SDK). */
export function getCompatibleWallets(): readonly Wallet[] {
  return getDiscoveredWallets().filter(w => SIGN_AND_SEND_FEATURE in w.features);
}

/** Test hook: clear module-level discovery state. */
export function resetWalletDiscoveryForTesting(): void {
  registered.clear();
  listeners.clear();
  discoveryStarted = false;
}
