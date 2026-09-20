/**
 * Product-chrome hero focal — Commitment Curve + commit panel mock.
 * Pattern: Stripe dashboard / Linear issue card in a floating device frame.
 * Decorative only; live trading lives on /asset/[symbol].
 */
export function HeroShowcase() {
  const rows = [
    { band: '$800B', w: 42, peak: false, amt: '$12.4k' },
    { band: '$900B', w: 68, peak: false, amt: '$28.1k' },
    { band: '$1.0T', w: 100, peak: true, amt: '$54.0k' },
    { band: '$1.1T', w: 55, peak: false, amt: '$19.6k' },
    { band: '$1.2T', w: 28, peak: false, amt: '$6.2k' },
    { band: '$1.4T', w: 12, peak: false, amt: '$1.8k' },
  ];

  return (
    <div className="device-frame float" style={{ width: '100%', maxWidth: 520 }}>
      <div className="device-chrome">
        <span className="device-dot" />
        <span className="device-dot" />
        <span className="device-dot" />
        <span
          className="fig"
          style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-faint)', flexGrow: 1 }}
        >
          OPENAI · Commitment Curve
        </span>
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--amber-ink)',
            background: 'var(--amber-wash)',
            borderRadius: 999,
            padding: '2px 8px',
          }}
        >
          Live
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.15fr 0.85fr',
          gap: 0,
          minHeight: 320,
        }}
      >
        {/* Curve */}
        <div style={{ padding: '20px 18px 22px', borderRight: '1px solid var(--line-soft)' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'baseline',
              marginBottom: 16,
            }}
          >
            <span className="label">Capital committed</span>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Market $1.05T</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.map((r, i) => (
              <div key={r.band} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  className="fig"
                  style={{
                    width: 48,
                    fontSize: 11,
                    textAlign: 'right',
                    color: r.peak ? 'var(--text)' : 'var(--text-muted)',
                    fontWeight: r.peak ? 500 : 400,
                    flexShrink: 0,
                  }}
                >
                  {r.band}
                </span>
                <div
                  style={{
                    flexGrow: 1,
                    height: 18,
                    background: 'var(--line-soft)',
                    borderRadius: 4,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    className="curve-bar"
                    style={{
                      width: `${r.w}%`,
                      height: '100%',
                      background: r.peak ? 'var(--amber-fill)' : 'var(--amber-soft)',
                      borderRadius: 4,
                      animationDelay: `${i * 50}ms`,
                    }}
                  />
                </div>
                <span
                  className="fig"
                  style={{
                    width: 46,
                    fontSize: 11,
                    textAlign: 'right',
                    color: 'var(--text-muted)',
                    flexShrink: 0,
                  }}
                >
                  {r.amt}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Mini commit panel */}
        <div style={{ padding: '20px 16px 18px', background: 'var(--surface)' }}>
          <div className="label" style={{ marginBottom: 14 }}>
            Commit
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
            <MiniField label="I would own around" value="$1.0T" />
            <MiniField label="Size" value="$100 USDC" />
            <MiniField label="Premium" value="$4.60" accent />
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              padding: '10px 0',
              borderTop: '1px solid var(--line-soft)',
              marginBottom: 14,
              fontSize: 12,
            }}
          >
            <MiniRow label="vs market" value="−4.8%" />
            <MiniRow label="Strike" value="$0.2140" />
            <MiniRow label="Premium / coll." value="4.6%" accent />
          </div>
          <div
            className="btn"
            style={{
              width: '100%',
              textAlign: 'center',
              pointerEvents: 'none',
              fontSize: 13,
              minHeight: 40,
              padding: '10px 14px',
            }}
          >
            Lock $100 USDC
          </div>
        </div>
      </div>
    </div>
  );
}

function MiniField({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 4 }}>{label}</div>
      <div
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: accent ? 'var(--amber-ink)' : 'var(--text)',
          background: 'var(--surface-muted)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          padding: '8px 10px',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function MiniRow({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ color: 'var(--text-faint)' }}>{label}</span>
      <span className="fig" style={{ color: accent ? 'var(--amber-ink)' : 'var(--text)' }}>
        {value}
      </span>
    </div>
  );
}
