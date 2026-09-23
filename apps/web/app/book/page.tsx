import { MakerBook } from '../../components/MakerBook';

export const metadata = { title: 'Your book — Rung' };

export default function BookPage() {
  return (
    <div className="wrap enter" style={{ paddingTop: 40, paddingBottom: 56 }}>
      <h1 style={{ fontSize: 'clamp(40px, 6vw, 54px)', marginBottom: 8 }}>Your book</h1>
      <p style={{ fontSize: 15, color: 'var(--text-faint)', margin: '0 0 28px', maxWidth: 660 }}>
        Every commitment you have made: how much of the capital holders took, how much is still
        on offer, and what the premium paid you. Read from chain, and nothing here is estimated
        except today&rsquo;s price in the P&amp;L.
      </p>
      <MakerBook />
    </div>
  );
}
