import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import type { Blockhash } from '@solana/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transferInstruction } from '../../../src/tx/pipeline.js';
import {
  createSignerFromWalletAccount,
  getCompatibleWallets,
  getDiscoveredWallets,
  resetWalletDiscoveryForTesting,
  watchWallets,
} from '../../../src/wallet/standard.js';

function makeAccount(address: string): WalletAccount {
  return {
    address,
    publicKey: new Uint8Array(32),
    chains: ['solana:devnet'],
    features: ['solana:signAndSendTransaction'],
  } as WalletAccount;
}

function makeWallet(
  name: string,
  account: WalletAccount,
  signAndSend?: (...inputs: unknown[]) => Promise<ReadonlyArray<{ signature: Uint8Array }>>,
): Wallet {
  return {
    version: '1.0.0',
    name,
    icon: 'data:image/svg+xml;base64,',
    chains: ['solana:devnet'],
    accounts: [account],
    features: signAndSend
      ? { 'solana:signAndSendTransaction': { version: '1.0.0', signAndSendTransaction: signAndSend } }
      : {},
  } as unknown as Wallet;
}

describe('wallet discovery', () => {
  beforeEach(() => {
    resetWalletDiscoveryForTesting();
    (globalThis as { window?: EventTarget }).window = new EventTarget();
  });
  afterEach(() => {
    resetWalletDiscoveryForTesting();
    delete (globalThis as { window?: EventTarget }).window;
  });

  it('registers wallets that announce themselves after the app', () => {
    const wallet = makeWallet('Phantom', makeAccount('abc'));
    const seen: string[][] = [];
    const unwatch = watchWallets(ws => seen.push(ws.map(w => w.name)));
    // Wallet loads later and dispatches the register event.
    window.dispatchEvent(
      new CustomEvent('wallet-standard:register-wallet', {
        detail: (api: { register: (...w: Wallet[]) => () => void }) => api.register(wallet),
      }),
    );
    expect(seen.at(-1)).toEqual(['Phantom']);
    expect(getDiscoveredWallets().map(w => w.name)).toEqual(['Phantom']);
    unwatch();
  });

  it('catches wallets already present at app start via app-ready', () => {
    const wallet = makeWallet('Solflare', makeAccount('xyz'));
    (globalThis.window as EventTarget).addEventListener('wallet-standard:app-ready', event => {
      const api = (event as CustomEvent<{ register: (...w: Wallet[]) => () => void }>).detail;
      api.register(wallet);
    });
    expect(getDiscoveredWallets().map(w => w.name)).toEqual(['Solflare']);
  });

  it('supports unregistering and filters compatible wallets', () => {
    const compatible = makeWallet('Good', makeAccount('a'), async () => [
      { signature: new Uint8Array(64) },
    ]);
    const incompatible = makeWallet('Bare', makeAccount('b'));
    let unregister: (() => void) | undefined;
    (globalThis.window as EventTarget).addEventListener('wallet-standard:app-ready', event => {
      const api = (event as CustomEvent<{ register: (...w: Wallet[]) => () => void }>).detail;
      unregister = api.register(compatible, incompatible);
    });
    expect(getDiscoveredWallets()).toHaveLength(2);
    expect(getCompatibleWallets().map(w => w.name)).toEqual(['Good']);
    unregister!();
    expect(getDiscoveredWallets()).toHaveLength(0);
  });

  it('is a safe no-op outside a browser environment', () => {
    delete (globalThis as { window?: EventTarget }).window;
    resetWalletDiscoveryForTesting();
    expect(getDiscoveredWallets()).toEqual([]);
  });
});

describe('createSignerFromWalletAccount', () => {
  it('encodes transactions to wire bytes and returns wallet signatures', async () => {
    const keypair = await generateKeyPairSigner();
    const blockhash = getBase58Decoder().decode(new Uint8Array(32).fill(3)) as Blockhash;
    const transaction = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(keypair, m),
        m => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 1n }, m),
        m => appendTransactionMessageInstructions([transferInstruction(keypair.address, keypair.address, 1n)], m),
      ),
    );

    const received: Uint8Array[] = [];
    const walletSignature = new Uint8Array(64).fill(5);
    const account = makeAccount(keypair.address);
    const wallet = makeWallet('Phantom', account, async (...inputs) => {
      for (const input of inputs as Array<{ transaction: Uint8Array; chain: string }>) {
        received.push(input.transaction);
        expect(input.chain).toBe('solana:devnet');
      }
      return inputs.map(() => ({ signature: walletSignature }));
    });

    const signer = createSignerFromWalletAccount(wallet, account);
    expect(signer.address).toBe(keypair.address);
    const signatures = await signer.signAndSendTransactions([transaction]);
    expect(signatures).toEqual([walletSignature]);

    // The wallet received exactly the canonical wire encoding.
    const expectedWire = Buffer.from(getBase64EncodedWireTransaction(transaction), 'base64');
    expect(Buffer.from(received[0]!).equals(expectedWire)).toBe(true);
  });

  it('honors an explicit chain override', async () => {
    const keypair = await generateKeyPairSigner();
    const blockhash = getBase58Decoder().decode(new Uint8Array(32).fill(3)) as Blockhash;
    const transaction = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(keypair, m),
        m => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 1n }, m),
        m => appendTransactionMessageInstructions([transferInstruction(keypair.address, keypair.address, 1n)], m),
      ),
    );
    const account = makeAccount(keypair.address);
    let seenChain = '';
    const wallet = makeWallet('Phantom', account, async (...inputs) => {
      seenChain = (inputs[0] as { chain: string }).chain;
      return [{ signature: new Uint8Array(64) }];
    });
    const signer = createSignerFromWalletAccount(wallet, account, { chain: 'solana:mainnet' });
    await signer.signAndSendTransactions([transaction]);
    expect(seenChain).toBe('solana:mainnet');
  });

  it('throws a helpful error for wallets without signAndSendTransaction', () => {
    const account = makeAccount('x');
    const wallet = makeWallet('Bare', account);
    expect(() => createSignerFromWalletAccount(wallet, account)).toThrow(
      /does not support solana:signAndSendTransaction/,
    );
  });
});
