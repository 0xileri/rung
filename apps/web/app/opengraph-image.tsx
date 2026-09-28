import { ImageResponse } from 'next/og';
import { C, CurveBars, Frame, OG_SIZE, assetCard, ogFonts, shortUsd, siteOrigin } from '../lib/og';

export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'Rung: put money behind a valuation. A capital-backed valuation market for PreStocks on Solana.';
export const revalidate = 300;

/** The card for the site as a whole: the idea on the left, OpenAI's live curve on the right. */
export default async function Image() {
  const [origin, fonts, card] = await Promise.all([siteOrigin(), ogFonts(), assetCard('OPENAI').catch(() => null)]);
  return new ImageResponse(
    (
      <Frame origin={origin} footer="Fully collateralized on Solana">
        <div style={{ display: 'flex', width: '100%', gap: 50, alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', width: 560 }}>
            <div style={{ display: 'flex', flexDirection: 'column', fontFamily: 'Serif', fontSize: 76, lineHeight: 1 }}>
              <span>Put money behind</span>
              <span style={{ display: 'flex', gap: 18 }}>
                <span>a</span>
                <span style={{ fontStyle: 'italic', color: C.gold }}>valuation.</span>
              </span>
            </div>
            <div style={{ display: 'flex', fontSize: 25, lineHeight: 1.45, color: C.muted, marginTop: 26 }}>
              Lock USDC at the valuation you&apos;d buy at. PreStocks holders pay you a premium for it.
            </div>
          </div>
          {card && card.totalUsd > 0 && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: 462,
                padding: '26px 28px',
                borderRadius: 22,
                border: `1px solid ${C.line}`,
                backgroundColor: 'rgba(242, 244, 248, 0.04)',
              }}
            >
              <span style={{ fontFamily: 'Mono', fontSize: 15, letterSpacing: 2.5, color: C.faint, marginBottom: 6 }}>
                OPENAI · LIVE ON DEVNET
              </span>
              <span style={{ fontFamily: 'Serif', fontSize: 32, marginBottom: 20 }}>{shortUsd(card.totalUsd)} committed to buy</span>
              <CurveBars buckets={card.buckets} width={404} />
            </div>
          )}
        </div>
      </Frame>
    ),
    { ...size, fonts },
  );
}
