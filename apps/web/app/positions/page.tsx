import { PositionList } from '../../components/PositionList';

export const metadata = { title: 'My Positions — Limit+' };

export default function PositionsPage() {
  return (
    <div className="wrap" style={{ paddingTop: 40, paddingBottom: 56 }}>
      <h1 style={{ fontSize: 40, marginBottom: 8 }}>My positions</h1>
      <p style={{ fontSize: 15, color: 'var(--text-faint)', margin: '0 0 28px', maxWidth: 640 }}>
        Everything you have committed capital to or bought protection on. Each position shows
        what is actually escrowed on chain, not what the interface believes should be.
      </p>
      <PositionList />
    </div>
  );
}
