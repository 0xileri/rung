import { ImageResponse } from 'next/og';
import { C, CurveBars, Frame, OG_SIZE, assetCard, bandLabel, ogFonts, shortUsd, siteOrigin } from '../../../lib/og';

export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'The live Commitment Curve: USDC escrowed at each valuation on Rung.';
export const revalidate = 120;

/** An asset's card: the question the page asks, and the capital already answering it. */
export default async function Image({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const [origin, fonts, card] = await Promise.all([siteOrigin(), ogFonts(), assetCard(symbol).catch(() => null)]);
  const name = card?.name ?? symbol.toUpperCase();
  const hasCapital = !!card && card.totalUsd > 0;
  return new ImageResponse(
    (
      <Frame origin={origin} footer="Live on Solana devnet">
        <div style={{ display: 'flex', width: '100%', gap: 52, alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', width: 520 }}>
            <span style={{ fontFamily: 'Mono', fontSize: 17, letterSpacing: 3, color: C.faint, marginBottom: 14 }}>
              {(card?.symbol ?? symbol).toUpperCase()} · COMMITMENT CURVE
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', fontFamily: 'Serif', fontSize: 72, lineHeight: 1 }}>
              <span>Where would you</span>
              <span style={{ display: 'flex', gap: 16 }}>
                <span>own</span>
                <span style={{ fontStyle: 'italic', color: C.gold }}>{name}?</span>
              </span>
            </div>
            <div style={{ display: 'flex', fontSize: 24, lineHeight: 1.45, color: C.muted, marginTop: 24 }}>
              {hasCapital
                ? `${shortUsd(card!.totalUsd)} of USDC already escrowed across ${card!.commitments} commitments from ${card!.wallets} wallets. Not a poll.`
                : 'No capital committed yet. Name your valuation and be the first on the curve.'}
            </div>
            {card && (
              <span style={{ fontFamily: 'Mono', fontSize: 18, color: C.faint, marginTop: 18 }}>
                Market trades at {bandLabel(card.marketValuation)}
              </span>
            )}
          </div>
          {card && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: 500,
                padding: '28px 30px',
                borderRadius: 22,
                border: `1px solid ${C.line}`,
                backgroundColor: 'rgba(242, 244, 248, 0.04)',
              }}
            >
              <span style={{ fontFamily: 'Serif', fontSize: 30, marginBottom: 22 }}>Capital committed to buy</span>
              <CurveBars buckets={card.buckets} width={438} />
            </div>
          )}
        </div>
      </Frame>
    ),
    { ...size, fonts },
  );
}
