/**
 * Share cards: the images a link to Rung unfolds into on X, Telegram and the rest.
 *
 * Rendered on the server by next/og (Satori), which lays out a subset of CSS: every element with
 * more than one child needs display:flex, there are no CSS variables, and fonts must be handed
 * over as TTF bytes. Colours below are the dark-ground values from styles/tokens.css, and the
 * figures come from the same chain reads and SDK arithmetic as the pages they preview, so a card
 * can never show a number its page does not.
 */
import { headers } from 'next/headers';
import { getPositionsCached } from './positions-cache';
import { fetchPositions, fillsFor, toOpenCommitments, type Position } from './chain';
import { getPreStocks, findAsset } from './prestocks-cache';
import { escrowTargetFor, symbolForMint } from './deployment';
import { buildCurve, curveSignal, type CurveBucket } from '../../../packages/sdk/src/commitment-curve.ts';
import { valuationBands, bandAnchor } from '../../../packages/sdk/src/valuation.ts';

export const OG_SIZE = { width: 1200, height: 630 };

export const C = {
  night: '#0b1424',
  night2: '#0e1a2e',
  chalk: '#f2f4f8',
  muted: '#c3ccda',
  faint: '#8e9aae',
  line: 'rgba(242, 244, 248, 0.12)',
  track: 'rgba(242, 244, 248, 0.08)',
  bar: 'rgba(242, 244, 248, 0.26)',
  amber: '#d68a34',
  gold: '#f2b35c',
  teal: '#6dd3c8',
};

/** The site's own origin, from the request: links and cards must point at the domain being shared. */
export async function siteOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'rung.up.railway.app';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/* ------------------------------------------------------------------ fonts */

const fontCache = new Map<string, Promise<ArrayBuffer | null>>();

/**
 * One Google font as TTF. Google serves TTF to clients that don't advertise WOFF2 (a bare server
 * fetch), which is the one format Satori reads. A failure resolves to null so the card still
 * renders in the built-in fallback font rather than not at all.
 */
function googleFont(family: string): Promise<ArrayBuffer | null> {
  if (!fontCache.has(family)) {
    fontCache.set(
      family,
      (async () => {
        try {
          const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${family}`)).text();
          const url = css.match(/src: url\((.+?)\) format\('(?:opentype|truetype)'\)/)?.[1];
          if (!url) return null;
          const res = await fetch(url);
          return res.ok ? await res.arrayBuffer() : null;
        } catch {
          return null;
        }
      })(),
    );
  }
  return fontCache.get(family)!;
}

export async function ogFonts() {
  const [serif, serifItalic, sans, sansBold, mono] = await Promise.all([
    googleFont('Instrument+Serif'),
    googleFont('Instrument+Serif:ital@1'),
    googleFont('IBM+Plex+Sans:wght@500'),
    googleFont('IBM+Plex+Sans:wght@600'),
    googleFont('IBM+Plex+Mono:wght@500'),
  ]);
  const fonts: { name: string; data: ArrayBuffer; weight?: 400 | 500 | 600; style?: 'normal' | 'italic' }[] = [];
  if (serif) fonts.push({ name: 'Serif', data: serif, weight: 400, style: 'normal' });
  if (serifItalic) fonts.push({ name: 'Serif', data: serifItalic, weight: 400, style: 'italic' });
  if (sans) fonts.push({ name: 'Sans', data: sans, weight: 500 });
  if (sansBold) fonts.push({ name: 'Sans', data: sansBold, weight: 600 });
  if (mono) fonts.push({ name: 'Mono', data: mono, weight: 500 });
  return fonts;
}

/* ------------------------------------------------------------------ pieces */

function Mark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      <rect x="6" y="7" width="16" height="6" rx="3" fill="#F7F6F3" />
      <rect x="6" y="17" width="24" height="6" rx="3" fill="#F7F6F3" />
      <rect x="6" y="27" width="34" height="6" rx="3" fill="#C98A3C" />
      <rect x="6" y="37" width="20" height="6" rx="3" fill="#F7F6F3" />
      <rect x="43" y="4" width="2" height="40" rx="1" fill="#F7F6F3" opacity="0.36" />
    </svg>
  );
}

/** The dark card every share image sits on: mark and name at the top, the domain at the foot. */
export function Frame({ origin, footer, children }: { origin: string; footer: string; children: React.ReactNode }) {
  const host = origin.replace(/^https?:\/\//, '');
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '52px 64px 44px',
        color: C.chalk,
        fontFamily: 'Sans',
        backgroundColor: C.night,
        backgroundImage: `radial-gradient(70% 80% at 88% 0%, rgba(27, 48, 80, 0.95), rgba(11, 20, 36, 0) 70%), linear-gradient(180deg, ${C.night}, ${C.night2})`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Mark size={40} />
        <span style={{ fontFamily: 'Serif', fontSize: 36 }}>Rung</span>
      </div>
      <div style={{ display: 'flex', flexGrow: 1, alignItems: 'center' }}>{children}</div>
      <div style={{ display: 'flex', fontFamily: 'Mono', fontSize: 18, color: C.faint, gap: 10 }}>
        <span style={{ color: C.chalk }}>{host}</span>
        <span>·</span>
        <span>{footer}</span>
      </div>
    </div>
  );
}

const shortUsd = (n: number) => (n >= 10_000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n).toLocaleString('en-US')}`);
const bandLabel = (v: number) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2).replace(/0$/, '')}T` : `$${Math.round(v / 1e9)}B`);

/**
 * The Commitment Curve as bars: one row per band, the band holding the most capital in amber.
 * Widths are in pixels, from the space the card gives it: Satori resolves percentage widths
 * inside a flex-grown track against the wrong box, which pushed bars over their labels.
 */
export function CurveBars({ buckets, highlight, width }: { buckets: CurveBucket[]; highlight?: number; width: number }) {
  const amounts = buckets.map((b) => Number(b.committed) / 1e6);
  const peak = Math.max(1, ...amounts);
  const track = width - 84 - 88 - 32;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, width: '100%' }}>
      {buckets.map((b, i) => {
        const amt = amounts[i];
        const isPeak = amt > 0 && amt === Math.max(...amounts);
        const mine = highlight !== undefined && Math.round(b.valuationUsd) === Math.round(highlight);
        return (
          <div key={b.valuationUsd} style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ fontFamily: 'Mono', fontSize: 20, width: 84, color: mine || isPeak ? C.chalk : C.muted }}>
              {bandLabel(b.valuationUsd)}
            </span>
            <div style={{ display: 'flex', width: track, height: 14, borderRadius: 999, backgroundColor: C.track }}>
              {amt > 0 && (
                <div
                  // Satori trims every style value it is given, so an undefined one crashes the
                  // render: optional styles are left out rather than set to undefined.
                  style={{
                    width: Math.max(8, Math.round((amt / peak) * track)),
                    height: 14,
                    borderRadius: 999,
                    backgroundColor: isPeak ? C.amber : C.bar,
                    ...(isPeak ? { backgroundImage: `linear-gradient(90deg, ${C.amber}, ${C.gold})` } : {}),
                    ...(mine ? { boxShadow: `0 0 0 3px ${C.teal}` } : {}),
                  }}
                />
              )}
            </div>
            <span style={{ fontFamily: 'Mono', fontSize: 20, width: 88, textAlign: 'right', color: amt > 0 ? C.chalk : C.faint, display: 'flex', justifyContent: 'flex-end' }}>
              {amt > 0 ? shortUsd(amt) : '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ data */

export type AssetCard = {
  symbol: string;
  name: string;
  marketValuation: number;
  buckets: CurveBucket[];
  totalUsd: number;
  commitments: number;
  wallets: number;
  /** Capital-weighted median floor of live commitments, or null. */
  medianFloorUsd: number | null;
};

/** An asset's live curve, computed exactly as its page computes it. */
export async function assetCard(symbol: string): Promise<AssetCard | null> {
  const { assets } = await getPreStocks();
  const asset = findAsset(assets, symbol);
  if (!asset) return null;
  const escrow = escrowTargetFor(asset.symbol, asset.contract_address);
  const fetched = await getPositionsCached();
  const open = fetched.ok ? toOpenCommitments(fetched.positions, escrow.mint) : [];
  const buckets = buildCurve(open, valuationBands(bandAnchor(asset), 6));
  const makers = new Set(fetched.ok ? fetched.positions.filter((p) => p.stockMint === escrow.mint && p.strikeQuoteOpen > 0n).map((p) => p.maker) : []);
  return {
    symbol: asset.symbol,
    name: asset.name.replace(/ PreStocks$/i, ''),
    marketValuation: asset.impliedValuation,
    buckets,
    totalUsd: buckets.reduce((s, b) => s + Number(b.committed) / 1e6, 0),
    commitments: open.length,
    wallets: makers.size,
    medianFloorUsd: curveSignal(open).medianFloorUsd,
  };
}

export type CommitmentCard = {
  position: Position;
  /** USDC holders have taken so far, across every slice. */
  takenUsd: number;
  slices: number;
  symbol: string | null;
  name: string;
  asset: AssetCard | null;
};

/**
 * One commitment. A link is usually shared seconds after the commitment lands, before the
 * cached read has caught up, so a miss in the cache falls back to one fresh read.
 */
export async function commitmentCard(pubkey: string): Promise<CommitmentCard | null> {
  let fetched = await getPositionsCached();
  let position = fetched.ok ? fetched.positions.find((p) => p.pubkey === pubkey) : undefined;
  if (!position) {
    fetched = await fetchPositions();
    position = fetched.ok ? fetched.positions.find((p) => p.pubkey === pubkey) : undefined;
  }
  if (!position || !fetched.ok) return null;
  const slices = fillsFor(fetched.fills, pubkey);
  const { assets } = await getPreStocks();
  const symbol = symbolForMint(position.stockMint, assets);
  const asset = symbol ? await assetCard(symbol) : null;
  return {
    position,
    takenUsd: slices.reduce((s, f) => s + Number(f.strikeQuoteAmount) / 1e6, 0),
    slices: slices.length,
    symbol,
    name: asset?.name ?? symbol ?? 'a PreStock',
    asset,
  };
}

export { bandLabel, shortUsd };
