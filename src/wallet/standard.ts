import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type {
  Address,
  SignatureBytes,
  Transaction,
  TransactionModifyingSigner,
  TransactionSendingSigner,
} from '@solana/kit';
import { getTransactionDecoder, getTransactionEncoder } from '@solana/kit';

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
const SIGN_TRANSACTION_FEATURE = 'solana:signTransaction';

interface SignAndSendFeature {
  signAndSendTransaction(
    ...inputs: Array<{
      readonly account: WalletAccount;
      readonly chain: string;
      readonly transaction: Uint8Array;
    }>
  ): Promise<ReadonlyArray<{ readonly signature: Uint8Array }>>;
}

interface SignTransactionFeature {
  signTransaction(
    ...inputs: Array<{
      readonly account: WalletAccount;
      readonly chain?: string;
      readonly transaction: Uint8Array;
    }>
  ): Promise<ReadonlyArray<{ readonly signedTransaction: Uint8Array }>>;
}

export interface CreateSignerOptions {
  /** Chain to submit on (default: the account's first `solana:` chain). */
  readonly chain?: string;
  /**
   * Prefer `solana:signTransaction` when the wallet offers it (default true).
   * Sign-only wallets let solana-shield keep the signed bytes, which unlocks
   * Jito routing and rebroadcast for wallet users. Set to false to force the
   * wallet's own send path.
   */
  readonly preferSignOnly?: boolean;
}

/**
 * Adapt a wallet-standard account into a kit signer for
 * `shield.sendReliably({ signer, ... })`.
 *
 * Feature selection, best-first:
 * 1. `solana:signTransaction` → a `TransactionModifyingSigner`: the wallet only
 *    signs, solana-shield owns the wire bytes — full Jito routing + rebroadcast.
 * 2. `solana:signAndSendTransaction` → a `TransactionSendingSigner`: the wallet
 *    signs AND submits, so the route degrades to RPC (with an explicit
 *    `jitoFallback` event); solana-shield still owns confirmation and expiry.
 */
export function createSignerFromWalletAccount(
  wallet: Wallet,
  account: WalletAccount,
  options: CreateSignerOptions = {},
): TransactionModifyingSigner | TransactionSendingSigner {
  const chain =
    options.chain ?? account.chains.find(c => c.startsWith('solana:')) ?? 'solana:mainnet';
  const encoder = getTransactionEncoder();

  const signOnly = wallet.features[SIGN_TRANSACTION_FEATURE] as SignTransactionFeature | undefined;
  if (options.preferSignOnly !== false && typeof signOnly?.signTransaction === 'function') {
    const decoder = getTransactionDecoder();
    const modifyingSigner: TransactionModifyingSigner = {
      address: account.address as Address,
      async modifyAndSignTransactions(transactions) {
        const outputs = await signOnly.signTransaction(
          ...transactions.map(transaction => ({
            account,
            chain,
            transaction: new Uint8Array(encoder.encode(transaction)),
          })),
        );
        return outputs.map(o => decoder.decode(o.signedTransaction)) as unknown as Awaited<
          ReturnType<TransactionModifyingSigner['modifyAndSignTransactions']>
        >;
      },
    };
    return modifyingSigner;
  }

  const sendAndSign = wallet.features[SIGN_AND_SEND_FEATURE] as SignAndSendFeature | undefined;
  if (!sendAndSign || typeof sendAndSign.signAndSendTransaction !== 'function') {
    throw new Error(
      `Wallet "${wallet.name}" supports neither ${SIGN_TRANSACTION_FEATURE} nor ${SIGN_AND_SEND_FEATURE}. ` +
        `Available features: ${Object.keys(wallet.features).join(', ')}`,
    );
  }

  return {
    address: account.address as Address,
    async signAndSendTransactions(
      transactions: readonly Transaction[],
    ): Promise<readonly SignatureBytes[]> {
      const outputs = await sendAndSign.signAndSendTransaction(
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

/** Wallets usable with this SDK (sign-only or sign-and-send capable). */
export function getCompatibleWallets(): readonly Wallet[] {
  return getDiscoveredWallets().filter(
    w => SIGN_TRANSACTION_FEATURE in w.features || SIGN_AND_SEND_FEATURE in w.features,
  );
}

/** Test hook: clear module-level discovery state. */
export function resetWalletDiscoveryForTesting(): void {
  registered.clear();
  listeners.clear();
  discoveryStarted = false;
}
