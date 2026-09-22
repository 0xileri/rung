import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ProtectMarket } from '../../../components/ProtectMarket';
import { getPreStocks, findAsset, getMintState } from '../../../lib/prestocks-cache';
import { relativeTo } from '../../../../../packages/sdk/src/valuation.ts';
import { pct, valuation } from '../../../lib/format';
import { escrowTargetFor, LISTED_SYMBOLS } from '../../../lib/deployment';

export const dynamic = 'force-dynamic';

export default async function ProtectPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;

  const { assets } = await getPreStocks();
  const asset = findAsset(assets, symbol);
  if (!asset) notFound();

  // Allowed to fail: a rate-limited mainnet RPC must not 404 a page whose valuations and
  // escrow parameters are already available.
  let mint: Awaited<ReturnType<typeof getMintState>> | null = null;
  try {
    mint = await getMintState(asset.contract_address);
  } catch {
    /* fall back to the escrow mint's known values below */
  }

  const escrow = escrowTargetFor(asset.symbol, asset.contract_address);
  const marketVsMark = relativeTo(asset.impliedValuation, asset.markValuation);

  // The fee schedule and multiplier must describe the token actually being escrowed. On
  // devnet that is the mock, whose one fee is known; sizing against the real mint's higher
  // slot there made holders send about 0.5% more than needed. On mainnet it is the live
  // mint, and without it the quantities cannot be trusted, so accepting is refused.
  const feeSlots = escrow.mock
    ? { older: escrow.feeBps ?? 0, newer: escrow.feeBps ?? 0, newerEpoch: '0' }
    : mint
      ? {
          older: mint.transferFeeConfig.olderTransferFee.transferFeeBasisPoints,
          newer: mint.transferFeeConfig.newerTransferFee.transferFeeBasisPoints,
          newerEpoch: mint.transferFeeConfig.newerTransferFee.epoch.toString(),
        }
      : null;
  const disabledReason = escrow.mock
    ? undefined
    : !escrow.listed
      ? `${asset.symbol} is not tradable on this deployment. Only ${LISTED_SYMBOLS.join(', ')} ${LISTED_SYMBOLS.length === 1 ? 'is' : 'are'} listed here.`
      : !mint
        ? 'The live mint could not be read just now, and its fee schedule and multiplier decide what you send. Reload in a moment.'
        : mint.transferHookProgramId
          ? 'The issuer has attached a transfer hook to this PreStock, which Rung cannot settle through yet, so it is not taking new positions.'
          : undefined;
  const name = asset.name.replace(' PreStocks', '');

  return (
    <div className="wrap enter" style={{ paddingTop: 36, paddingBottom: 48, maxWidth: 900 }}>
      <div style={{ marginBottom: 28 }}>
        <div className="label" style={{ marginBottom: 7 }}>
          Protect {asset.symbol}
        </div>
        <h1 style={{ fontSize: 42, marginBottom: 14 }}>Sell the upside, keep a floor</h1>
        <p style={{ fontSize: 16, lineHeight: 1.55, color: 'var(--text-muted)', maxWidth: 640, margin: 0 }}>
          You already hold {name}. Someone has locked USDC at a valuation they would buy at. Take
          their side of it: lock your tokens, collect a premium, and gain the right to exchange
          them for that USDC at any point before expiry.
        </p>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 32,
          flexWrap: 'wrap',
          padding: '16px 20px',
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow-soft)',
          marginBottom: 24,
        }}
      >
        <Stat label="Market implied" value={valuation(asset.impliedValuation)} />
        <Stat label="PreStocks mark" value={valuation(asset.markValuation)} />
        <Stat label="Market vs mark" value={pct(marketVsMark)} accent />
        <div style={{ flexGrow: 1 }} />
        <Link href={`/asset/${asset.symbol}`} style={{ fontSize: 13, alignSelf: 'center' }}>
          See the Commitment Curve &rarr;
        </Link>
      </div>

      <ProtectMarket
        symbol={asset.symbol}
        stockMint={escrow.mint}
        decimals={escrow.decimals ?? mint?.decimals ?? 9}
        multiplier={escrow.multiplier ?? mint?.multiplier ?? 1}
        // Only reached with null when disabledReason is set, which blocks accepting.
        feeSlots={feeSlots ?? { older: 100, newer: 100, newerEpoch: '0' }}
        disabledReason={disabledReason}
      />

      <p style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-faint)', marginTop: 24 }}>
        Exercising is your decision alone. Rung never asks a price feed whether it is rational,
        which is why no oracle sits in the settlement path &mdash;{' '}
        <Link href="/limitations">what this does not do</Link>.
      </p>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>{label}</div>
      <div className="fig" style={{ fontSize: 18, color: accent ? 'var(--amber-ink)' : undefined }}>
        {value}
      </div>
    </div>
  );
}
