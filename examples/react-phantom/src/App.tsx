import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EndpointHealthSnapshot, TxStatusEvent } from 'solana-shield';
import { createShield, transferInstruction } from 'solana-shield';
import { createSignerFromWalletAccount, watchWallets } from 'solana-shield/wallet';
import { address } from '@solana/kit';

interface ConnectFeature {
  connect(): Promise<{ accounts: readonly WalletAccount[] }>;
}

function stringify(event: TxStatusEvent): string {
  return JSON.stringify(event, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

export function App() {
  const shield = useMemo(
    () =>
      createShield({
        endpoints: ['devnet'],
        // Add your own endpoints for real failover, e.g.:
        // endpoints: ['https://devnet.helius-rpc.com/?api-key=KEY', 'devnet'],
      }),
    [],
  );
  useEffect(() => () => shield.destroy(), [shield]);

  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [account, setAccount] = useState<{ wallet: Wallet; account: WalletAccount }>();
  const [events, setEvents] = useState<TxStatusEvent[]>([]);
  const [health, setHealth] = useState<EndpointHealthSnapshot[]>([]);
  const [busy, setBusy] = useState(false);
  const walletRef = useRef<HTMLDivElement>(null);

  useEffect(() => watchWallets(setWallets), []);
  useEffect(() => {
    const interval = setInterval(() => setHealth(shield.health.snapshots()), 1000);
    return () => clearInterval(interval);
  }, [shield]);

  async function connect(wallet: Wallet) {
    const feature = wallet.features['standard:connect'] as ConnectFeature | undefined;
    const accounts = feature ? (await feature.connect()).accounts : wallet.accounts;
    const solanaAccount = accounts.find(a => a.chains.some(c => c.startsWith('solana:')));
    if (solanaAccount) setAccount({ wallet, account: solanaAccount });
  }

  async function send() {
    if (!account) return;
    setBusy(true);
    setEvents([]);
    try {
      const signer = createSignerFromWalletAccount(account.wallet, account.account, {
        chain: 'solana:devnet',
      });
      const self = address(account.account.address);
      const handle = shield.sendReliably({
        instructions: [transferInstruction(self, self, 1000n)],
        signer,
      });
      for await (const event of handle) {
        setEvents(prev => [...prev, event]);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={walletRef}>
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
          <button disabled={busy} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send 1000 lamports to self (devnet)'}
          </button>
        </section>
      )}

      {events.length > 0 && (
        <section>
          <h2>Transaction lifecycle</h2>
          {events.map((event, i) => (
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
