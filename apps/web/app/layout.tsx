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
    { rel: 'mask-icon', url: '/icon-mask.svg', color: '#0E1116' },
  ],
};

/** Navigation stays at three items, per the spec's warning against a dense trading terminal. */
const NAV = [
  { href: '/', label: 'Discover' },
  { href: '/asset/OPENAI', label: 'Commit' },
  { href: '/positions', label: 'My Positions' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletRoot>
        <header style={{ background: 'var(--ink)' }}>
          <div
            className="wrap"
            style={{ display: 'flex', alignItems: 'center', gap: 28, padding: '15px 24px', flexWrap: 'wrap' }}
          >
            <Link
              href="/"
              style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}
            >
              <Mark size={26} reversed />
              <Wordmark size={23} reversed />
            </Link>
            <nav style={{ display: 'flex', gap: 22, flexGrow: 1 }}>
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  style={{ fontSize: 14, color: 'var(--text-muted)', textDecoration: 'none' }}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <span className="fig" style={{ fontSize: 12, color: '#8B9099' }}>
              {process.env.NEXT_PUBLIC_CLUSTER ?? 'devnet'}
            </span>
            <WalletBar />
          </div>
        </header>

        <main style={{ minHeight: '70vh' }}>{children}</main>

        <footer style={{ borderTop: '1px solid var(--line)', marginTop: 64, padding: '28px 0' }}>
          <div className="wrap" style={{ fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.6 }}>
            <p style={{ margin: '0 0 8px' }}>
              Experimental software, unaudited. PreStocks provide economic exposure to
              private-company-linked assets and may be restricted in some jurisdictions. Rung is
              not investment advice.
            </p>
            <p style={{ margin: 0 }}>
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
