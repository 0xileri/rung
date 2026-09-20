/**
 * Pre-demo preflight (spec §79: "token mint verified", "no stale API assumptions").
 *
 * Re-reads the live API and mint on every run and prints the values the protocol depends
 * on. Run it before recording or submitting: the transfer fee is on an epoch schedule and
 * the scaled-UI multiplier can be re-armed, so yesterday's numbers are not evidence.
 *
 *   node scripts/verify-chain.ts [SYMBOL] [RPC_URL]
 */
import { fetchPreStock, fetchMintState, rpcFromUrl, custodyCaveats } from '../packages/sdk/src/prestocks.ts';
import { quoteStrike } from '../packages/sdk/src/valuation.ts';

const symbol = process.argv[2] ?? 'OPENAI';
const rpcUrl = process.argv[3] ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

const asset = await fetchPreStock(symbol);
const mint = await fetchMintState(asset.contract_address, rpcFromUrl(rpcUrl));

console.log(`ASSET    ${asset.symbol}  mark $${asset.markPrice.toFixed(2)}  markVal $${(asset.markValuation / 1e12).toFixed(4)}T  implied $${(asset.impliedValuation / 1e12).toFixed(4)}T`);
console.log(`MINT     ${mint.mint}`);
console.log(`         decimals ${mint.decimals} | program ${mint.tokenProgram}`);
console.log(`RESOLVED multiplier ${mint.multiplier} | transfer fee ${mint.transferFee.transferFeeBasisPoints}bps (epoch >= ${mint.transferFee.epoch})`);

const q = quoteStrike({
  asset, targetValuation: 1.0e12, strikeUsd: 100,
  decimals: mint.decimals, multiplier: mint.multiplier, transferFee: mint.transferFee,
});
console.log('');
console.log(`QUOTE    $100 @ $1.00T -> strike $${q.targetTokenPrice.toFixed(4)}/token`);
console.log(`         ui ${q.uiQuantity.toFixed(9)}  RAW ${q.rawQuantity}`);
console.log(`         vs market ${(q.discountToMarket * 100).toFixed(2)}%  vs mark ${(q.discountToMark * 100).toFixed(2)}%`);
console.log(`         round-trip transfer fee ${(q.roundTripFeeFraction * 100).toFixed(2)}%`);
console.log('');
console.log('CUSTODY CAVEATS (derived from chain, must be disclosed in UI):');
for (const c of custodyCaveats(mint)) console.log(`  - ${c}`);
if (mint.paused) { console.error('\nFAIL: mint is paused; settlement cannot execute.'); process.exit(1); }
