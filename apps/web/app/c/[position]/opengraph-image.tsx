import { ImageResponse } from 'next/og';
import { C, CurveBars, Frame, OG_SIZE, bandLabel, commitmentCard, ogFonts, siteOrigin } from '../../../lib/og';

export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'A commitment on Rung: USDC escrowed at a private-company valuation.';
export const revalidate = 60;

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: 34 }}>
      <span style={{ fontSize: 17, color: C.faint }}>{label}</span>
      <span style={{ fontFamily: 'Mono', fontSize: 30, color: accent ?? C.chalk }}>{value}</span>
    </div>
  );
}

/** A commitment's card: who would own what, at which valuation, and what is still there to take. */
export default async function Image({ params }: { params: Promise<{ position: string }> }) {
  const { position } = await params;
  const [origin, fonts, card] = await Promise.all([siteOrigin(), ogFonts(), commitmentCard(position).catch(() => null)]);

  if (!card) {
    return new ImageResponse(
      (
        <Frame origin={origin} footer="Live on Solana devnet">
          <span style={{ fontFamily: 'Serif', fontSize: 72 }}>Put money behind a valuation.</span>
        </Frame>
      ),
      { ...size, fonts },
    );
  }

  const p = card.position;
  const escrowed = Number(p.strikeQuoteEscrowed) / 1e6;
  const open = Number(p.strikeQuoteOpen) / 1e6;
  const premium = Number(p.premiumQuoteAmount) / 1e6;
  const expired = Date.now() / 1000 > p.expiryTs;
  const closed = expired || p.status === 'Settled' || p.status === 'Cancelled';
  const days = Math.max(0, Math.ceil((p.expiryTs - Date.now() / 1000) / 86400));

  return new ImageResponse(
    (
      <Frame origin={origin} footer={closed ? 'Live on Solana devnet' : 'Take the other side on Solana devnet'}>
        <div style={{ display: 'flex', width: '100%', gap: 44, alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', width: 600 }}>
            <span style={{ fontFamily: 'Mono', fontSize: 17, letterSpacing: 3, color: C.faint, marginBottom: 14 }}>
              {(card.symbol ?? '').toUpperCase()} · COMMITMENT
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', fontFamily: 'Serif', fontSize: 72, lineHeight: 1 }}>
              <span>I&apos;d own {card.name}</span>
              <span style={{ display: 'flex', gap: 16 }}>
                <span>at</span>
                <span style={{ fontStyle: 'italic', color: C.gold }}>{bandLabel(p.targetValuationUsd)}.</span>
              </span>
            </div>
            <div style={{ display: 'flex', fontSize: 24, lineHeight: 1.45, color: C.muted, marginTop: 22 }}>
              {money(escrowed)} USDC escrowed on Solana behind it.
              {closed ? '' : ' A holder can take any slice as a floor.'}
            </div>
            <div style={{ display: 'flex', marginTop: 30 }}>
              {closed ? (
                <Stat label="Status" value={p.status === 'Cancelled' ? 'Withdrawn' : 'Closed'} />
              ) : (
                <Stat label="Open to take" value={money(open)} accent={C.gold} />
              )}
              <Stat label="Taken" value={money(card.takenUsd)} />
              {!closed && <Stat label="Premium" value={`${((premium / escrowed) * 100).toFixed(1)}%`} />}
              {!closed && <Stat label="Deadline" value={`${days}d`} />}
            </div>
          </div>
          {card.asset && card.asset.totalUsd > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: 428,
                padding: '24px 26px',
                borderRadius: 22,
                border: `1px solid ${C.line}`,
                backgroundColor: 'rgba(242, 244, 248, 0.04)',
              }}
            >
              <span style={{ fontFamily: 'Serif', fontSize: 26, marginBottom: 18 }}>{card.name} curve</span>
              <CurveBars buckets={card.asset.buckets} highlight={p.targetValuationUsd} width={374} />
            </div>
          )}
        </div>
      </Frame>
    ),
    { ...size, fonts },
  );
}
