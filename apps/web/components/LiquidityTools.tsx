import Link from 'next/link';

/**
 * What makes the book fill: slices, sweeps, ladders, a maker's book and the keeper.
 *
 * A commitment is not one bet with one counterparty. Many holders can each take part of it,
 * a holder can take a whole band of them at once, a maker can spread capital across a range
 * and run it as a book, and nothing past its deadline waits on anyone coming back. Each card
 * names the mechanism, says what it does in the program's own terms, and links to where it
 * lives in the app.
 */
export function LiquidityTools({ symbol }: { symbol: string }) {
  const tools: { label: string; tint: 'amber' | 'teal'; title: string; body: string; href: string; cta: string }[] = [
    {
      label: 'Slices',
      tint: 'teal',
      title: 'Take any part of a floor',
      body:
        'One commitment serves many holders. Take $10 of it or all of it: each slice is its own claim, ' +
        'with its own collateral, priced pro rata against what the maker escrowed.',
      href: `/protect/${symbol}`,
      cta: 'Buy a floor',
    },
    {
      label: 'Sweep',
      tint: 'teal',
      title: 'A band of protection, one approval',
      body:
        'Ask for $150 and it fills across floors, cheapest premium first, packed into as few ' +
        'transactions as will fit.',
      href: `/protect/${symbol}`,
      cta: 'Sweep a band',
    },
    {
      label: 'Ladder',
      tint: 'amber',
      title: 'Commit across a range',
      body:
        'Spread USDC from one valuation to another in one approval: evenly, or with more at the ' +
        'lower valuations you would rather own at.',
      href: `/asset/${symbol}`,
      cta: 'Build a ladder',
    },
    {
      label: 'Your book',
      tint: 'amber',
      title: 'Run it like a book',
      body:
        'What holders took, what is still on offer, what the premium paid and your capital over ' +
        'time. Withdraw what nobody took; settle what has run out.',
      href: '/book',
      cta: 'Open your book',
    },
  ];

  return (
    <section className="wrap" style={{ paddingBottom: 88 }}>
      <h2 style={{ fontSize: 36, marginBottom: 10 }}>Made to fill</h2>
      <p style={{ fontSize: 16, color: 'var(--text-muted)', margin: '0 0 24px', maxWidth: 560, lineHeight: 1.55 }}>
        Capital on the curve is only worth something if it can be taken. So it can be taken in
        pieces, in bands, and across a range, and none of it gets stuck.
      </p>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 14,
        }}
      >
        {tools.map((t) => (
          <li
            key={t.label}
            className={`card tint-${t.tint}`}
            style={{ padding: '22px 20px', display: 'flex', flexDirection: 'column' }}
          >
            <div className="label" style={{ marginBottom: 10, color: `var(--${t.tint}-ink)` }}>
              {t.label}
            </div>
            <h3 style={{ fontSize: 17, fontWeight: 600, marginBottom: 8, letterSpacing: '-0.02em' }}>{t.title}</h3>
            <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: 0, lineHeight: 1.55, flexGrow: 1 }}>{t.body}</p>
            <Link href={t.href} style={{ fontSize: 13, fontWeight: 600, marginTop: 14 }}>
              {t.cta} &rarr;
            </Link>
          </li>
        ))}
      </ul>
      {/* Not a fifth tool: the guarantee under all four, so it spans them. */}
      <div
        className="card on-dark"
        style={{ marginTop: 14, padding: '22px 24px', display: 'flex', gap: '10px 32px', flexWrap: 'wrap', alignItems: 'baseline' }}
      >
        <div style={{ flex: '1 1 240px' }}>
          <div className="label" style={{ marginBottom: 10, color: 'var(--amber-ink)' }}>
            Keeper
          </div>
          <h3 style={{ fontSize: 17, fontWeight: 600, margin: 0, letterSpacing: '-0.02em' }}>Nothing waits on a counterparty</h3>
        </div>
        <p style={{ flex: '2 1 320px', fontSize: 14, color: 'var(--text-muted)', margin: 0, lineHeight: 1.55 }}>
          Past its deadline, anyone may settle a claim: the maker&rsquo;s USDC and the holder&rsquo;s
          tokens go home, and nothing else can move. A keeper does it for everyone every ten
          minutes, and because anyone may, nobody depends on the keeper either.
        </p>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 16, maxWidth: 640 }}>
        The protocol&rsquo;s cut comes out of the premium, is capped at 5% by the program, and is
        never taken from collateral.
      </p>
    </section>
  );
}
