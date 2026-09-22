import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { Mark, Wordmark } from '../components/Mark';
import { WalletRoot, WalletBar } from '../components/WalletBar';

export const metadata: Metadata = {
  title: 'Rung — capital-backed valuations for PreStocks',
  description:
    'Lock USDC at the private-company valuation where you would actually own exposure. PreStocks holders pay for the right to exchange their tokens for that capital before expiry.',
  icons: [
    { rel: 'icon', url: '/favicon.svg', type: 'image/svg+xml' },
    { rel: 'mask-icon', url: '/icon-mask.svg', color: '#0A0A0A' },
  ],
};

const NAV = [
  { href: '/', label: 'Discover' },
  { href: '/asset/OPENAI', label: 'Commit' },
  { href: '/protect/OPENAI', label: 'Protect' },
  { href: '/positions', label: 'My Positions' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletRoot>
          <header className="site-header">
            <div
              className="wrap"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 28,
                padding: '12px 24px',
                flexWrap: 'wrap',
                minHeight: 'var(--header-h)',
              }}
            >
              <Link
                href="/"
                style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}
              >
                <Mark size={24} />
                <Wordmark size={20} />
              </Link>
              <nav
                className="site-nav"
                style={{ display: 'flex', gap: 24, flexGrow: 1, flexWrap: 'wrap' }}
              >
                {NAV.map((item) => (
                  <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
                    {item.label}
                  </Link>
                ))}
              </nav>
              <span className="cluster-pill">
                {process.env.NEXT_PUBLIC_CLUSTER ?? 'devnet'}
              </span>
              <WalletBar />
            </div>
          </header>

          <main style={{ minHeight: '70vh' }}>{children}</main>

          <footer className="site-footer">
            <div className="wrap" style={{ fontSize: 13, color: 'var(--text-faint)', lineHeight: 1.65 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
                <Mark size={26} />
                <Wordmark size={20} />
              </div>
              <p style={{ margin: '0 0 10px', maxWidth: 720 }}>
                Experimental software, unaudited. PreStocks provide economic exposure to
                private-company-linked assets and may be restricted in some jurisdictions. Rung is
                not investment advice.
              </p>
              <p style={{ margin: 0, maxWidth: 720 }}>
                Positions are collateralized in program-controlled vaults. The PreStocks issuer holds
                permanent delegate, freeze and pause authority over the mint, so that holds subject to
                issuer trust &mdash;{' '}
                <Link href="/limitations">read the limitations</Link>.
              </p>
            </div>
          </footer>
        </WalletRoot>
      </body>
    </html>
  );
}
