/**
 * The Limit+ mark: bars of committed capital stepping out from the market line.
 *
 * Inline rather than an <img> so it inherits the surrounding colour and can be reversed on
 * a dark ground without shipping a second file.
 */
export function Mark({ size = 28, reversed = false }: { size?: number; reversed?: boolean }) {
  const base = reversed ? 'var(--paper)' : 'var(--ink)';
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Limit+">
      <rect x="6" y="7" width="16" height="6" rx="3" fill={base} />
      <rect x="6" y="17" width="24" height="6" rx="3" fill={base} />
      {/* The peak bar: where capital actually concentrates. */}
      <rect x="6" y="27" width="34" height="6" rx="3" fill="var(--amber-fill)" />
      <rect x="6" y="37" width="20" height="6" rx="3" fill={base} />
      {/* The market line. No bar reaches it, because buyers commit below where it trades. */}
      <rect x="43" y="4" width="2" height="40" rx="1" fill={base} opacity={reversed ? 0.36 : 0.28} />
    </svg>
  );
}

export function Wordmark({ size = 24, reversed = false }: { size?: number; reversed?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 1 }}>
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: size,
          lineHeight: 1,
          color: reversed ? 'var(--paper)' : 'var(--text)',
        }}
      >
        Limit
      </span>
      <span style={{ fontFamily: 'var(--font-display)', fontSize: size, lineHeight: 1, color: 'var(--amber-fill)' }}>
        +
      </span>
    </span>
  );
}
