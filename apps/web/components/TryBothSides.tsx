import Link from 'next/link';
import { FaucetButton } from './FaucetButton';

/**
 * "Try both sides", for devnet only: the four steps from a fresh wallet to a matched
 * position. Nothing here is needed on mainnet, where the tokens are real.
 */
export function TryBothSides({ symbol }: { symbol: string }) {
  const steps: { title: string; body: React.ReactNode }[] = [
    {
      title: 'Switch your wallet to devnet',
      body: <>In Phantom: Settings &rarr; Developer settings &rarr; Testnet mode, Solana Devnet.</>,
    },
    {
      title: 'Get test tokens',
      body: <FaucetButton />,
    },
    {
      title: 'Commit at a valuation',
      body: (
        <>
          On <Link href={`/asset/${symbol}`}>{symbol}</Link>, pick where you would own it and lock
          USDC. You earn the premium if a holder takes it.
        </>
      ),
    },
    {
      title: 'Take the other side',
      body: (
        <>
          From a second wallet, open <Link href={`/protect/${symbol}`}>Protect</Link>, buy a floor,
          then watch both sides and their P&amp;L on <Link href="/positions">My Positions</Link>.
        </>
      ),
    },
  ];

  return (
    <section className="wrap" style={{ paddingBottom: 56 }}>
      <h2 className="label" style={{ margin: '0 0 14px' }}>
        Try both sides on devnet
      </h2>
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 14,
        }}
      >
        {steps.map((s, i) => (
          <li key={s.title} className="card" style={{ padding: '16px 18px' }}>
            <div className="step-badge" style={{ marginBottom: 12 }}>
              {i + 1}
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{s.title}</div>
            <div style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-muted)' }}>{s.body}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}
