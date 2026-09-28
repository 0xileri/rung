/**
 * Take the other side of a commitment, as a Solana Action.
 *
 *   GET  /api/actions/take/<position>           -> the Blink: card, buttons, amount field
 *   POST /api/actions/take/<position>?amount=N  -> an unsigned accept_commitment for the wallet
 *
 * The transaction is the one the Protect page builds, from the same builder and SDK math: the
 * slice priced pro rata by quoteFill, the stock grossed up against the worse of the mint's two
 * fee slots. Everything is read fresh from chain at POST time, and the things a wallet would
 * only discover by failing a simulation -- too small a slice, not enough tokens, taking your
 * own commitment -- are answered up front in a sentence.
 */
import { PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { actionError, actionJson, isTakeable, preflight, readOnlyProgram, readPosition, type LivePosition } from '../../../../../lib/actions';
import { buildAcceptCommitment, loadProtocolAccounts, type ProtocolAccounts } from '../../../../../lib/program';
import { connection } from '../../../../../lib/chain';
import { siteOrigin } from '../../../../../lib/og';
import { getPreStocks } from '../../../../../lib/prestocks-cache';
import { symbolForMint } from '../../../../../lib/deployment';
import { band, usd } from '../../../../../lib/format';
import { fillRejection, quoteFill } from '../../../../../../../packages/sdk/src/fills.ts';
import { grossUpForRequired, worstCaseTransferFee } from '../../../../../../../packages/sdk/src/token2022.ts';
import { fetchMintState, rpcFromUrl } from '../../../../../../../packages/sdk/src/prestocks.ts';

export const dynamic = 'force-dynamic';

const PRESETS = [10, 50];
const fromRaw = (raw: bigint) => Number(raw) / 1e6;

type Context = { params: Promise<{ position: string }> };

async function load(positionParam: string) {
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(positionParam);
  } catch {
    return { error: 'That is not a commitment address.' } as const;
  }
  const program = readOnlyProgram();
  const p = await readPosition(program, pubkey);
  if (!p) return { error: 'No commitment exists at that address.' } as const;
  const loaded = await loadProtocolAccounts(program, p.stockMint);
  if (!loaded.ok) return { error: loaded.detail } as const;
  const { assets } = await getPreStocks();
  const symbol = symbolForMint(p.stockMint.toBase58(), assets) ?? 'PRESTOCK';
  const name = assets.find((a) => a.symbol === symbol)?.name.replace(/ PreStocks$/i, '') ?? symbol;
  return { program, p, accounts: loaded.accounts, symbol, name } as const;
}

const termsOf = (p: LivePosition) => ({
  strikeQuoteEscrowed: p.strikeQuoteEscrowed,
  strikeQuoteOpen: p.strikeQuoteOpen,
  stockRawRequired: p.stockRawRequired,
  premiumQuoteAmount: p.premiumQuoteAmount,
});

/** Why a slice is refused, in the person's terms; null when it is fine. */
function sliceProblem(p: LivePosition, accounts: ProtocolAccounts, strike: bigint): string | null {
  const why = fillRejection(termsOf(p), strike, accounts.minFillQuote);
  const min = usd(fromRaw(accounts.minFillQuote));
  const open = usd(fromRaw(p.strikeQuoteOpen));
  if (why === 'empty') return 'Enter an amount of USDC to take.';
  if (why === 'exceeds-open') return `Only ${open} of this floor is still open.`;
  if (why === 'below-minimum') return `The smallest slice is ${min}. Take at least that, or all ${open}.`;
  if (why === 'leaves-dust') return `That would leave less than ${min} behind, too little for anyone else to take. Take a little less, or all ${open}.`;
  return null;
}

export const OPTIONS = preflight;

export async function GET(_req: Request, ctx: Context) {
  const { position } = await ctx.params;
  const origin = await siteOrigin();
  const loaded = await load(position);
  if (loaded.error !== undefined) return actionError(loaded.error, 404);
  const { p, accounts, name } = loaded;

  const open = fromRaw(p.strikeQuoteOpen);
  const escrowed = fromRaw(p.strikeQuoteEscrowed);
  const premiumPct = (fromRaw(p.premiumQuoteAmount) / escrowed) * 100;
  const deadline = new Date(p.expiryTs * 1000).toUTCString().slice(5, 16);
  const href = (amount: string) => `${origin}/api/actions/take/${p.pubkey.toBase58()}?amount=${amount}`;
  const takeable = isTakeable(p) && !accounts.paused && accounts.marketEnabled;

  const presets = PRESETS.filter((a) => !sliceProblem(p, accounts, BigInt(a * 1e6))).map((a) => ({
    type: 'transaction',
    label: `Take $${a}`,
    href: href(String(a)),
  }));
  return actionJson({
    type: 'action',
    icon: `${origin}/c/${p.pubkey.toBase58()}/opengraph-image`,
    title: `I'd own ${name} at ${band(p.targetValuationUsd)}`,
    description:
      `${usd(escrowed)} USDC escrowed on Solana at a ${band(p.targetValuationUsd)} valuation, ${usd(open)} still open. ` +
      `Take any slice as a floor under your ${name} PreStocks: lock the tokens, pay a ${premiumPct.toFixed(1)}% premium, ` +
      `and swap them for this USDC any time before ${deadline}. Fully collateralized, no oracle.`,
    label: 'Take the other side',
    ...(takeable ? {} : { disabled: true, error: { message: 'This commitment is no longer open to take.' } }),
    links: {
      actions: [
        ...presets,
        { type: 'transaction', label: `Take all ${usd(open)}`, href: href('all') },
        {
          type: 'transaction',
          label: 'Take',
          href: href('{amount}'),
          parameters: [
            {
              type: 'number',
              name: 'amount',
              label: `USDC of floor, ${usd(fromRaw(accounts.minFillQuote))} to ${usd(open)}`,
              required: true,
              min: fromRaw(accounts.minFillQuote),
              max: open,
            },
          ],
        },
      ],
    },
  });
}

export async function POST(req: Request, ctx: Context) {
  const { position } = await ctx.params;
  const origin = await siteOrigin();
  let taker: PublicKey;
  try {
    const body = (await req.json()) as { account?: string };
    taker = new PublicKey(body.account ?? '');
  } catch {
    return actionError('A wallet address is needed to build the transaction.');
  }

  const loaded = await load(position);
  if (loaded.error !== undefined) return actionError(loaded.error, 404);
  const { program, p, accounts, name, symbol } = loaded;
  if (!isTakeable(p)) return actionError('This commitment is no longer open to take.');
  if (accounts.paused || !accounts.marketEnabled) return actionError('Taking is paused on this market right now.');
  if (taker.equals(p.maker)) return actionError('You made this commitment. A maker cannot take their own.');

  const amountParam = new URL(req.url).searchParams.get('amount') ?? '';
  const strike =
    amountParam === 'all'
      ? p.strikeQuoteOpen
      : BigInt(Math.round((Number(amountParam) || 0) * 100)) * 10_000n; // whole cents, in raw units
  const problem = sliceProblem(p, accounts, strike);
  if (problem) return actionError(problem);

  const conn = connection();
  const quote = quoteFill(termsOf(p), strike, accounts.feeBps);
  const mint = await fetchMintState(p.stockMint.toBase58(), rpcFromUrl(conn.rpcEndpoint));
  const send = grossUpForRequired(quote.stockRawRequired, worstCaseTransferFee(mint.transferFeeConfig));

  // What a wallet would otherwise learn from a failed simulation.
  const stockAta = getAssociatedTokenAddressSync(p.stockMint, taker, false, accounts.stockTokenProgram);
  const quoteAta = getAssociatedTokenAddressSync(accounts.quoteMint, taker, false, accounts.quoteTokenProgram);
  const [sol, stock, usdc] = await Promise.all([
    conn.getBalance(taker),
    conn.getTokenAccountBalance(stockAta).then((b) => BigInt(b.value.amount)).catch(() => 0n),
    conn.getTokenAccountBalance(quoteAta).then((b) => BigInt(b.value.amount)).catch(() => 0n),
  ]);
  const faucet = `Get free test tokens at ${origin.replace(/^https?:\/\//, '')}.`;
  if (stock < send) return actionError(`This slice locks ${symbol} tokens you do not have in this wallet. ${faucet}`);
  if (usdc < quote.premiumQuote) return actionError(`The premium is ${usd(fromRaw(quote.premiumQuote))} in USDC, more than this wallet holds. ${faucet}`);
  if (sol < 3_000_000) return actionError(`This wallet needs a little SOL for fees and the claim's rent. ${faucet}`);

  const ix = await buildAcceptCommitment(program, {
    taker,
    position: p.pubkey,
    maker: p.maker,
    accounts,
    stockRawToSend: send,
    fillStrikeQuote: strike,
    fillIndex: p.fillsCreated,
  });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: taker, blockhash, lastValidBlockHeight }).add(ix);
  const slice = usd(fromRaw(strike));

  return actionJson({
    type: 'transaction',
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    message: `Protection on ${slice} of ${name} at ${band(p.targetValuationUsd)} for a ${usd(fromRaw(quote.premiumQuote))} premium.`,
    links: {
      next: {
        type: 'inline',
        action: {
          type: 'completed',
          icon: `${origin}/c/${p.pubkey.toBase58()}/opengraph-image`,
          title: `Protection active: ${slice} at ${band(p.targetValuationUsd)}`,
          description: `Your ${name} tokens are escrowed with the maker's USDC. Exercise any time before the deadline at ${origin.replace(/^https?:\/\//, '')}/positions.`,
          label: 'Done',
        },
      },
    },
  });
}
