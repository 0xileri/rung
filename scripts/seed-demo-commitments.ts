/**
 * Seed a few open OpenAI commitments on devnet so the Commitment Curve and the Protect page
 * have something real to show in a demo.
 *
 *   bash scripts/wsl/run.sh node scripts/seed-demo-commitments.ts [--dry-run]
 *
 * Signs with the deployer key (~/.config/solana/id.json), which setup-devnet funded with mock
 * USDC. Quantities come from the SDK's quoteStrike against the live PreStocks API -- the same
 * path the web app takes -- so a seeded position is indistinguishable from one a person made
 * in the UI.
 *
 * There is deliberately no fallback price. If the API is down the script stops: a commitment
 * seeded at an invented mark would put a false point on a curve whose whole claim is that it
 * is recomputable from chain and live data.
 *
 * Re-running is safe. A target the deployer already has an Open commitment at is skipped.
 *
 * Uses public devnet unless SEED_RPC_URL is set. Only the host of that URL is ever printed,
 * because paid RPC URLs carry their API key in the query string.
 */
import { readFileSync } from 'node:fs';
import { AnchorProvider, BN, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { fetchPreStock } from '../packages/sdk/src/prestocks.ts';
import { isFeedConsistent, quoteStrike, valuationBands } from '../packages/sdk/src/valuation.ts';

const SYMBOL = 'OPENAI';
const EXPIRY_DAYS = 30;

// Nearest floor first. Premium falls as the floor gets deeper, because protection further
// below the mark is less likely to be exercised.
const LADDER = [
  { sizeUsd: 150, premiumRate: 0.05 },
  { sizeUsd: 120, premiumRate: 0.035 },
  { sizeUsd: 100, premiumRate: 0.025 },
];

const rpc = process.env.SEED_RPC_URL ?? 'https://api.devnet.solana.com';
const DRY_RUN = process.argv.includes('--dry-run');

function randomNonce(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return new DataView(b.buffer).getBigUint64(0, true);
}

function valuationLabel(v: number): string {
  return v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : `$${Math.round(v / 1e9)}B`;
}

async function main() {
  const connection = new Connection(rpc, 'confirmed');
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))),
  );
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed' });

  const deployment = JSON.parse(readFileSync('devnet.json', 'utf8'));
  const market = deployment.markets[SYMBOL];
  if (!market) throw new Error(`devnet.json has no ${SYMBOL} market`);
  const programId = new PublicKey(deployment.programId);
  const quoteMint = new PublicKey(deployment.quoteMint);
  const stockMint = new PublicKey(market.mint);

  const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl & { address: string };
  if (idl.address !== programId.toBase58()) {
    throw new Error(
      `IDL address ${idl.address} does not match devnet.json program ${programId.toBase58()}; run scripts/sync-idl.sh`,
    );
  }
  const program = new Program(idl, provider);

  console.log(`RPC      ${rpc.split('?')[0]}`);
  console.log(`Wallet   ${payer.publicKey.toBase58()}`);
  console.log(`Program  ${programId.toBase58()}`);

  const asset = await fetchPreStock(SYMBOL);
  if (!isFeedConsistent(asset)) {
    throw new Error(
      'PreStocks mark and implied valuations disagree on share count; the web app disables creation in this state, so the seed does too.',
    );
  }
  console.log(
    `Live     implied ${valuationLabel(asset.impliedValuation)}  mark ${valuationLabel(asset.markValuation)}  mark price $${asset.markPrice.toFixed(2)}`,
  );

  // Floors on the same grid the curve buckets into, strictly below the mark.
  const floors = valuationBands(asset.markValuation, 6).filter((v) => v < asset.markValuation);
  if (floors.length < LADDER.length) throw new Error(`Only ${floors.length} bands below the mark`);
  const seeds = LADDER.map((rung, i) => ({ ...rung, target: floors[i] }));

  const existing = await program.account.position.all();
  const alreadyOpen = new Set(
    existing
      .filter((p) => {
        const a = p.account as { maker: PublicKey; stockMint: PublicKey; status: object; targetValuationUsd: BN };
        return (
          a.maker.equals(payer.publicKey) &&
          a.stockMint.equals(stockMint) &&
          Object.keys(a.status)[0]?.toLowerCase() === 'open'
        );
      })
      .map((p) => (p.account as { targetValuationUsd: BN }).targetValuationUsd.toString()),
  );
  const todo = seeds.filter((s) => !alreadyOpen.has(String(Math.round(s.target))));
  for (const s of seeds) {
    if (!todo.includes(s)) console.log(`Skip     ${valuationLabel(s.target)} -- already open`);
  }
  if (todo.length === 0) {
    console.log('Nothing to seed.');
    return;
  }

  const quoteAta = getAssociatedTokenAddressSync(quoteMint, payer.publicKey, false, TOKEN_PROGRAM_ID);
  const balance = (await getAccount(connection, quoteAta, 'confirmed', TOKEN_PROGRAM_ID)).amount;
  const needed = todo.reduce((sum, s) => sum + BigInt(Math.round(s.sizeUsd * 1e6)), 0n);
  console.log(`USDC     ${Number(balance) / 1e6} held, ${Number(needed) / 1e6} needed`);
  if (balance < needed) throw new Error('Not enough mock USDC to escrow every strike');

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], programId);
  const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from('market'), stockMint.toBuffer()], programId);
  const expiryTs = Math.floor(Date.now() / 1000) + EXPIRY_DAYS * 86400;
  const created: { label: string; position: string; sig: string }[] = [];

  for (const seed of todo) {
    const quote = quoteStrike({
      asset,
      targetValuation: seed.target,
      strikeUsd: seed.sizeUsd,
      decimals: market.decimals,
      multiplier: market.multiplier,
      transferFee: { epoch: 0n, transferFeeBasisPoints: market.feeBps, maximumFee: 2n ** 64n - 1n },
    });
    const premium = BigInt(Math.round(seed.sizeUsd * seed.premiumRate * 1e6));

    const nonce = randomNonce();
    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64LE(nonce);
    const [position] = PublicKey.findProgramAddressSync(
      [Buffer.from('position'), payer.publicKey.toBuffer(), nonceBuf],
      programId,
    );
    const [authority] = PublicKey.findProgramAddressSync(
      [Buffer.from('position_authority'), position.toBuffer()],
      programId,
    );

    const label = valuationLabel(seed.target);
    console.log('');
    console.log(`Create   ${label} floor, $${seed.sizeUsd} USDC, $${Number(premium) / 1e6} premium`);
    console.log(`         $${quote.targetTokenPrice.toFixed(4)}/token, raw ${quote.rawQuantity}`);
    if (DRY_RUN) continue;

    const ix = await program.methods
      .createCommitment(
        new BN(nonce.toString()),
        new BN(quote.rawQuantity.toString()),
        new BN(quote.strikeQuoteAmount.toString()),
        new BN(premium.toString()),
        new BN(expiryTs),
        new BN(Math.round(seed.target).toString()),
      )
      .accounts({
        maker: payer.publicKey,
        config,
        market: marketPda,
        position,
        positionAuthority: authority,
        stockMint,
        quoteMint,
        makerQuoteAccount: quoteAta,
        quoteVault: getAssociatedTokenAddressSync(quoteMint, authority, true, TOKEN_PROGRAM_ID),
        stockVault: getAssociatedTokenAddressSync(stockMint, authority, true, TOKEN_2022_PROGRAM_ID),
        stockTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const tx = new Transaction().add(ix);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer.publicKey;
    tx.sign(payer);
    const sig = await connection.sendRawTransaction(tx.serialize());
    let failedOnChain: unknown = null;
    try {
      const { value } = await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      // An on-chain failure comes back as a value, not an exception.
      failedOnChain = value.err;
    } catch (e) {
      // A confirmation timeout does not mean the transaction failed. The position address is
      // fixed by the nonce, so check for it rather than guess -- and never re-send, which
      // would create a second commitment if the first did land.
      if (!(await connection.getAccountInfo(position, 'confirmed'))) throw e;
    }
    if (failedOnChain) {
      throw new Error(`create ${label} failed on-chain: ${JSON.stringify(failedOnChain)} (tx ${sig})`);
    }
    console.log(`         position ${position.toBase58()}`);
    created.push({ label, position: position.toBase58(), sig });
  }

  if (DRY_RUN) {
    console.log('\nDry run: nothing sent.');
    return;
  }
  console.log('');
  console.log('Seeded:');
  for (const c of created) {
    console.log(`  ${c.label}  https://explorer.solana.com/tx/${c.sig}?cluster=devnet`);
  }
  console.log(`\nCurve:   https://rung.up.railway.app/asset/${SYMBOL}`);
  console.log(`Protect: https://rung.up.railway.app/protect/${SYMBOL}`);
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  if (e && typeof e === 'object' && 'logs' in e) console.error((e as { logs: string[] }).logs);
  process.exit(1);
});
