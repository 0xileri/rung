/**
 * The Rung mark: bars of committed capital stepping out from the market line.
 * Inline SVG so it inherits surrounding colour.
 */
export function Mark({ size = 28, reversed = false }: { size?: number; reversed?: boolean }) {
  const base = reversed ? 'var(--chalk)' : 'var(--text)';
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Rung">
      <rect x="6" y="7" width="16" height="6" rx="3" fill={base} />
      <rect x="6" y="17" width="24" height="6" rx="3" fill={base} />
      <rect x="6" y="27" width="34" height="6" rx="3" fill="var(--amber-fill)" />
      <rect x="6" y="37" width="20" height="6" rx="3" fill={base} />
      <rect x="43" y="4" width="2" height="40" rx="1" fill={base} opacity={reversed ? 0.4 : 0.22} />
    </svg>
  );
}

export function Wordmark({ size = 20, reversed = false }: { size?: number; reversed?: boolean }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-sans)',
        fontSize: size,
        fontWeight: 600,
        lineHeight: 1,
        letterSpacing: '-0.03em',
        color: reversed ? 'var(--chalk)' : 'var(--text)',
      }}
    >
      Rung
    </span>
  );
}
