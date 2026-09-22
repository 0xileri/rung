import { NextResponse } from 'next/server';
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
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

/**
 * Devnet test-token faucet, so anyone can try both sides of Rung without asking.
 *
 * Mock USDC and mock OPENAI exist only because this project minted them, so nobody can get
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
/** Raw units; about 2.97 OPENAI as a wallet shows it, enough to take any floor up to the cap. */
const STOCK_GRANT = 2n * 10n ** 9n;
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
  const stock = new PublicKey(devnet.markets.OPENAI.mint);
  const decimals = { usdc: devnet.quoteDecimals, stock: devnet.markets.OPENAI.decimals };

  try {
    const tx = new Transaction();
    const sol = await conn.getBalance(recipient);
    const sendSol = sol < SOL_FLOOR;
    if (sendSol) {
      tx.add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: recipient, lamports: SOL_GRANT }));
    }
    const toUsdc = getAssociatedTokenAddressSync(usdc, recipient, false, TOKEN_PROGRAM_ID);
    const toStock = getAssociatedTokenAddressSync(stock, recipient, false, TOKEN_2022_PROGRAM_ID);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, toUsdc, recipient, usdc, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(faucet.publicKey, toStock, recipient, stock, TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(usdc, faucet.publicKey, false, TOKEN_PROGRAM_ID),
        usdc,
        toUsdc,
        faucet.publicKey,
        USDC_GRANT,
        decimals.usdc,
        [],
        TOKEN_PROGRAM_ID,
      ),
      createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(stock, faucet.publicKey, false, TOKEN_2022_PROGRAM_ID),
        stock,
        toStock,
        faucet.publicKey,
        STOCK_GRANT,
        decimals.stock,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    const signature = await sendAndConfirmByPolling(conn, tx, faucet);

    lastClaimByWallet.set(wallet, now);
    claimsByIp.set(ip, [...recent, now]);
    // What lands, not what was sent: the mock charges a transfer fee like the real mint.
    const arrives = amountReceived(STOCK_GRANT, {
      epoch: 0n,
      transferFeeBasisPoints: devnet.markets.OPENAI.feeBps,
      maximumFee: 2n ** 64n - 1n,
    });
    return NextResponse.json({
      signature,
      sol: sendSol ? SOL_GRANT / LAMPORTS_PER_SOL : 0,
      usdc: Number(USDC_GRANT) / 10 ** decimals.usdc,
      stockUi: rawToUi(arrives, decimals.stock, devnet.markets.OPENAI.multiplier),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/insufficient (lamports|funds)/i.test(message)) {
      return fail(503, 'The faucet has run dry. It is topped up by hand; please try again later.');
    }
    return fail(502, `The faucet transaction failed: ${message.split('\n')[0].slice(0, 160)}`);
  }
}
