import { address } from '@solana/kit';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { useEffect, useState } from 'react';
import { transferInstruction } from 'solana-shield';
import type { TxStatusEvent } from 'solana-shield';
import { useEndpointHealth, useSendReliably, useShield } from 'solana-shield/react';
import { createSignerFromWalletAccount, watchWallets } from 'solana-shield/wallet';

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly WalletAccount[] }>;
}

function stringify(event: TxStatusEvent): string {
  return JSON.stringify(event, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

export function App() {
  // The whole SDK, wired with three hooks: a resilient client, a live send, and live health.
  const shield = useShield({ endpoints: ['devnet'] });
  const tx = useSendReliably(shield);
  const health = useEndpointHealth(shield, 1000);

  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [account, setAccount] = useState<{ wallet: Wallet; account: WalletAccount }>();

  useEffect(() => watchWallets(setWallets), []);

  async function connect(wallet: Wallet) {
    const feature = wallet.features['standard:connect'] as ConnectFeature | undefined;
    const accounts = feature ? (await feature.connect()).accounts : wallet.accounts;
    const solanaAccount = accounts.find(a => a.chains.some(c => c.startsWith('solana:')));
    if (solanaAccount) setAccount({ wallet, account: solanaAccount });
  }

  function send() {
    if (!account) return;
    const signer = createSignerFromWalletAccount(account.wallet, account.account, {
      chain: 'solana:devnet',
    });
    const self = address(account.account.address);
    tx.send({ instructions: [transferInstruction(self, self, 1000n)], signer });
  }

  return (
    <div>
      <h1>solana-shield × Phantom (devnet)</h1>

      {!account && (
        <section>
          <h2>1. Connect a wallet</h2>
          {wallets.length === 0 && <p>No wallet-standard wallets detected. Install Phantom.</p>}
          {wallets.map(w => (
            <button key={w.name} onClick={() => void connect(w)} style={{ marginRight: 8 }}>
              Connect {w.name}
            </button>
          ))}
        </section>
      )}

      {account && (
        <section>
          <h2>2. Send a reliable transaction</h2>
          <p>
            {account.wallet.name}: <code>{account.account.address}</code>
          </p>
          <button disabled={tx.isPending} onClick={send}>
            {tx.isPending ? `${tx.status}…` : 'Send 1000 lamports to self (devnet)'}
          </button>
          {tx.result && (
            <p className="event confirmed">
              ✅ confirmed in slot {String(tx.result.slot)} via {tx.result.confirmedVia} (route{' '}
              {tx.result.route}, {tx.result.attempts} broadcast(s), {tx.result.durationMs}ms)
            </p>
          )}
          {tx.error != null && <p className="event failed">❌ {String(tx.error)}</p>}
        </section>
      )}

      {tx.events.length > 0 && (
        <section>
          <h2>Transaction lifecycle</h2>
          {tx.events.map((event, i) => (
            <div key={i} className={`event ${event.type}`}>
              {stringify(event)}
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Endpoint health (live)</h2>
        <table>
          <thead>
            <tr>
              <th>endpoint</th><th>state</th><th>score</th><th>p50</th><th>p95</th><th>err%</th><th>slot lag</th>
            </tr>
          </thead>
          <tbody>
            {health.map(h => (
              <tr key={h.id}>
                <td>{h.label}</td>
                <td>{h.dead ? 'DEAD' : h.breakerState}</td>
                <td>{h.score.toFixed(3)}</td>
                <td>{h.p50Ms.toFixed(0)}ms</td>
                <td>{h.p95Ms.toFixed(0)}ms</td>
                <td>{(h.errorRateEwma * 100).toFixed(1)}%</td>
                <td>{h.slotLag}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
