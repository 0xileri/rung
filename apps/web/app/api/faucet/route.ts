import { NextResponse } from 'next/server';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';
import { amountReceived, rawToUi } from '../../../../../packages/sdk/src/token2022.ts';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import devnet from '../../../../../devnet.json';
import { CLUSTER, connection } from '../../../lib/chain';
import { findAsset, getPreStocks } from '../../../lib/prestocks-cache';

/**
 * Devnet test-token faucet, so anyone can try both sides of Rung without asking.
 *
 * The devnet mocks (USDC and each listed PreStock) exist only because this project minted them, so nobody can get
 * them elsewhere. The faucet TRANSFERS from its own stocked wallet (scripts/setup-faucet.ts)
 * rather than minting: the only key this server holds is FAUCET_SECRET_KEY, which owns
 * nothing but devnet SOL and devnet mocks. The deployer key, which can upgrade the program,
 * never comes near it.
 *
 * Rate-limited in memory per wallet and per IP. That resets on redeploy, which is fine for
 * tokens with no value; the limit exists so one script cannot drain the faucet's SOL.
 */

export const dynamic = 'force-dynamic';

/** One position at the program's $1,000 cap. */
const USDC_GRANT = 1_000n * 10n ** 6n;
/**
 * Each mock is granted by value, at today's market price. Token prices differ tenfold
 * (OpenAI ~$1,100, SpaceX ~$118), so a fixed count cannot be right for both; $2,500 covers
 * taking a $1,000 floor even at the deepest band, where each token is worth least.
 */
const STOCK_GRANT_USD = 2_500;
const SOL_GRANT = 0.05 * LAMPORTS_PER_SOL;
/** Below this, the wallet cannot pay for its accounts' rent, so it gets SOL as well. */
const SOL_FLOOR = 0.02 * LAMPORTS_PER_SOL;
const PER_WALLET_MS = 12 * 60 * 60 * 1000;
const PER_IP_WINDOW_MS = 60 * 60 * 1000;
const PER_IP_MAX = 5;

const lastClaimByWallet = new Map<string, number>();
const claimsByIp = new Map<string, number[]>();

function faucetKey(): Keypair | null {
  const raw = process.env.FAUCET_SECRET_KEY;
  if (!raw) return null;
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    return null;
  }
}

type DevnetMarket = { mint: string; decimals: number; multiplier: number; feeBps: number };

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

/**
 * Send, then confirm by polling signature status over HTTP.
 *
 * `sendAndConfirmTransaction` confirms over a websocket, and the `ws` client fails inside
 * Next's server bundle ("b.mask is not a function"): the transfer lands but the request
 * hangs. Polling needs nothing but the RPC's HTTP endpoint.
 */
async function sendAndConfirmByPolling(conn: Connection, tx: Transaction, signer: Keypair): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  const signature = await conn.sendRawTransaction(tx.serialize());
  for (;;) {
    const { value } = await conn.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature;
    if ((await conn.getBlockHeight('confirmed')) > lastValidBlockHeight) throw new Error('transaction expired before confirming');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function POST(request: Request) {
  if (CLUSTER === 'mainnet-beta') return fail(404, 'The faucet only exists on devnet.');
  const faucet = faucetKey();
  if (!faucet) return fail(503, 'The faucet is not configured on this deployment.');

  let recipient: PublicKey;
  try {
    const body = (await request.json()) as { address?: string };
    recipient = new PublicKey(String(body.address));
    if (!PublicKey.isOnCurve(recipient.toBytes())) throw new Error('not a wallet');
  } catch {
    return fail(400, 'Send a wallet address.');
  }

  const now = Date.now();
  const wallet = recipient.toBase58();
  const last = lastClaimByWallet.get(wallet);
  if (last && now - last < PER_WALLET_MS) {
    const hours = Math.ceil((PER_WALLET_MS - (now - last)) / 3_600_000);
    return fail(429, `This wallet was funded recently. Try again in about ${hours}h.`);
  }
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const recent = (claimsByIp.get(ip) ?? []).filter((t) => now - t < PER_IP_WINDOW_MS);
  if (recent.length >= PER_IP_MAX) return fail(429, 'Too many requests from this network. Try again within the hour.');

  const conn = connection();
  const usdc = new PublicKey(devnet.quoteMint);
  // Every listed market's mock, so a tester can try each one, each sized by live price.
  let assets: Awaited<ReturnType<typeof getPreStocks>>['assets'];
  try {
    ({ assets } = await getPreStocks());
  } catch {
    return fail(503, 'Live prices are unavailable, so grants cannot be sized. Try again shortly.');
  }
  const stocks = Object.entries(devnet.markets as Record<string, DevnetMarket>).flatMap(([symbol, m]) => {
    const price = findAsset(assets, symbol)?.tokenPrice;
    if (!price || price <= 0) return [];
    const ui = STOCK_GRANT_USD / price;
    // The spread goes first so the PublicKey is not overwritten by devnet.json's string.
    return [{ ...m, symbol, mint: new PublicKey(m.mint), raw: BigInt(Math.ceil((ui / m.multiplier) * 10 ** m.decimals)) }];
  });

  const sol = await conn.getBalance(recipient).catch(() => SOL_FLOOR);
  const sendSol = sol < SOL_FLOOR;

  // One group per grant; each group's instructions must land together.
  const toUsdc = getAssociatedTokenAddressSync(usdc, recipient, false, TOKEN_PROGRAM_ID);
  const groups: { label: string; ixs: TransactionInstruction[] }[] = [
    {
      label: 'USDC',
      ixs: [
        ...(sendSol ? [SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: recipient, lamports: SOL_GRANT })] : []),
        createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, toUsdc, recipient, usdc, TOKEN_PROGRAM_ID),
        createTransferCheckedInstruction(
          getAssociatedTokenAddressSync(usdc, faucet.publicKey, false, TOKEN_PROGRAM_ID),
          usdc,
          toUsdc,
          faucet.publicKey,
          USDC_GRANT,
          devnet.quoteDecimals,
          [],
          TOKEN_PROGRAM_ID,
        ),
      ],
    },
    ...stocks.map((s) => {
      const to = getAssociatedTokenAddressSync(s.mint, recipient, false, TOKEN_2022_PROGRAM_ID);
      return {
        label: s.symbol,
        ixs: [
          createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, to, recipient, s.mint, TOKEN_2022_PROGRAM_ID),
          createTransferCheckedInstruction(
            getAssociatedTokenAddressSync(s.mint, faucet.publicKey, false, TOKEN_2022_PROGRAM_ID),
            s.mint,
            to,
            faucet.publicKey,
            s.raw,
            s.decimals,
            [],
            TOKEN_2022_PROGRAM_ID,
          ),
        ],
      };
    }),
  ];

  // Eight assets do not fit one transaction's 1,232 bytes, so the grant goes out in batches.
  const batches = packIntoTransactions(groups, faucet.publicKey);
  const signatures: string[] = [];
  const sent: string[] = [];
  try {
    for (const batch of batches) {
      signatures.push(await sendAndConfirmByPolling(conn, batch.tx, faucet));
      sent.push(...batch.labels);
    }
  } catch (err) {
    // Whatever already landed counts as a claim, so a failure cannot be retried into a drain.
    if (signatures.length > 0) {
      lastClaimByWallet.set(wallet, now);
      claimsByIp.set(ip, [...recent, now]);
    }
    const message = err instanceof Error ? err.message : String(err);
    const partial = sent.length ? ` Sent before it stopped: ${sent.join(', ')}.` : '';
    if (/insufficient (lamports|funds)/i.test(message)) {
      return fail(503, `The faucet has run dry and is topped up by hand; please try again later.${partial}`);
    }
    return fail(502, `The faucet transaction failed: ${message.split('\n')[0].slice(0, 160)}.${partial}`);
  }

  lastClaimByWallet.set(wallet, now);
  claimsByIp.set(ip, [...recent, now]);
  return NextResponse.json({
    signatures,
    sol: sendSol ? SOL_GRANT / LAMPORTS_PER_SOL : 0,
    usdc: Number(USDC_GRANT) / 10 ** devnet.quoteDecimals,
    // What lands, not what was sent: each mock charges a transfer fee like the real mint.
    stocks: stocks.map((s) => ({
      symbol: s.symbol,
      ui: rawToUi(
        amountReceived(s.raw, { epoch: 0n, transferFeeBasisPoints: s.feeBps, maximumFee: 2n ** 64n - 1n }),
        s.decimals,
        s.multiplier,
      ),
    })),
  });
}

/**
 * Greedily pack instruction groups into as few legacy transactions as fit, measuring the
 * serialized size rather than guessing a batch count: the limit is bytes, and how many
 * grants fit depends on how many accounts they share.
 */
function packIntoTransactions(groups: { label: string; ixs: TransactionInstruction[] }[], payer: PublicKey) {
  const MAX_TX_BYTES = 1232;
  const size = (tx: Transaction) => {
    tx.feePayer = payer;
    tx.recentBlockhash = PublicKey.default.toBase58(); // placeholder; the real one is set on send
    try {
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    } catch {
      // web3.js throws "Transaction too large" rather than returning an oversized length.
      return Number.POSITIVE_INFINITY;
    }
  };
  const out: { tx: Transaction; labels: string[] }[] = [];
  let current = { tx: new Transaction(), labels: [] as string[] };
  for (const g of groups) {
    const trial = new Transaction().add(...current.tx.instructions, ...g.ixs);
    if (current.labels.length > 0 && size(trial) > MAX_TX_BYTES) {
      out.push(current);
      current = { tx: new Transaction().add(...g.ixs), labels: [g.label] };
    } else {
      current = { tx: trial, labels: [...current.labels, g.label] };
    }
  }
  if (current.labels.length > 0) out.push(current);
  return out;
}
