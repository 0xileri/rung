/**
 * Stand up a devnet demo environment.
 *
 *   node scripts/setup-devnet.ts
 *
 * PreStocks only exist on mainnet, so devnet needs a stand-in. The mock created here
 * deliberately mirrors the REAL OpenAI PreStock rather than being a plain token: same 9
 * decimals, the same 50bps transfer fee, and the same 1.4861347 scaled-amount multiplier.
 * That matters because those two extensions are exactly what the protocol has to cope with —
 * a mock without them would demo a path the real asset never takes.
 *
 * It is a mock and is labelled as one everywhere it appears. Valuation data stays live from
 * the real mainnet PreStocks API throughout; only the escrowed token is synthetic.
 *
 * Idempotent-ish: re-running creates fresh mints. The existing config and market are reused
 * if already present, and the resulting addresses are written to devnet.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AnchorProvider, BN, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddressSync,
  createMint,
  mintTo,
} from '@solana/spl-token';

// Mirrors the live OpenAI PreStock, verified against mainnet.
const STOCK_DECIMALS = 9;
const QUOTE_DECIMALS = 6;
const FEE_BPS = 50;
const MULTIPLIER = 1.4861347;
const SYMBOL = 'OPENAI';

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

const cfg = env();
const RPC = cfg.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const connection = new Connection(RPC, 'confirmed');

const keypairPath = `${process.env.HOME}/.config/solana/id.json`;
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(keypairPath, 'utf8'))),
);
const wallet = new Wallet(payer);
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
const idl = JSON.parse(readFileSync('target/idl/rung.json', 'utf8')) as Idl;
const program = new Program(idl, provider);

const log = (...a: unknown[]) => console.log(...a);

async function main() {
  log(`RPC      ${RPC.split('?')[0]}`);
  log(`Wallet   ${payer.publicKey.toBase58()}`);
  log(`Balance  ${(await connection.getBalance(payer.publicKey)) / 1e9} SOL`);
  log(`Program  ${program.programId.toBase58()}`);

  const info = await connection.getAccountInfo(program.programId);
  if (!info?.executable) throw new Error('Program is not deployed on this cluster yet.');
  log('');

  // ---- mock USDC: legacy SPL Token, no extensions, exactly like the real thing ----
  log('Creating mock USDC (legacy SPL Token, 6 decimals)…');
  const quoteMint = await createMint(
    connection, payer, payer.publicKey, null, QUOTE_DECIMALS, undefined, undefined, TOKEN_PROGRAM_ID,
  );
  log(`  ${quoteMint.toBase58()}`);

  // ---- mock PreStock: Token-2022 with BOTH extensions the real mint carries ----
  log('Creating mock PreStock (Token-2022, transfer fee + scaled amount)…');
  const stockKp = Keypair.generate();
  const stockMint = stockKp.publicKey;
  const len = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.ScaledUiAmountConfig]);
  const lamports = await connection.getMinimumBalanceForRentExemption(len);

  // Every extension must be initialized BEFORE initializeMint, or the mint is rejected.
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: stockMint,
      space: len,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(
      stockMint, payer.publicKey, payer.publicKey, FEE_BPS,
      BigInt('18446744073709551615'), TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeScaledUiAmountConfigInstruction(
      stockMint, payer.publicKey, MULTIPLIER, TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      stockMint, STOCK_DECIMALS, payer.publicKey, null, TOKEN_2022_PROGRAM_ID,
    ),
  );
  await provider.sendAndConfirm(tx, [stockKp]);
  log(`  ${stockMint.toBase58()}  (${FEE_BPS}bps fee, multiplier ${MULTIPLIER})`);

  // ---- demo balances ----
  log('Minting demo balances…');
  const myQuote = await createAssociatedTokenAccountIdempotent(
    connection, payer, quoteMint, payer.publicKey, {}, TOKEN_PROGRAM_ID,
  );
  const myStock = await createAssociatedTokenAccountIdempotent(
    connection, payer, stockMint, payer.publicKey, {}, TOKEN_2022_PROGRAM_ID,
  );
  await mintTo(connection, payer, quoteMint, myQuote, payer, 50_000n * 10n ** BigInt(QUOTE_DECIMALS), [], undefined, TOKEN_PROGRAM_ID);
  await mintTo(connection, payer, stockMint, myStock, payer, 500n * 10n ** BigInt(STOCK_DECIMALS), [], undefined, TOKEN_2022_PROGRAM_ID);
  log(`  50,000 mock USDC and 500 mock ${SYMBOL}`);

  // ---- protocol accounts ----
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('market'), stockMint.toBuffer()], program.programId,
  );

  if (await connection.getAccountInfo(configPda)) {
    log(`Config already initialized at ${configPda.toBase58()}`);
  } else {
    log('Initializing config…');
    await program.methods
      .initializeConfig()
      .accounts({
        admin: payer.publicKey,
        config: configPda,
        quoteMint,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    log(`  ${configPda.toBase58()}`);
  }

  log(`Allowlisting ${SYMBOL}…`);
  await program.methods
    .addMarket(SYMBOL)
    .accounts({
      admin: payer.publicKey,
      config: configPda,
      market: marketPda,
      stockMint,
      stockTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  log(`  ${marketPda.toBase58()}`);

  const out = {
    cluster: 'devnet',
    note: 'PreStocks exist only on mainnet. The stock mint below is a MOCK that reproduces the real OpenAI PreStock’s transfer fee and scaled-amount extensions. Valuation data remains live from the real PreStocks API.',
    programId: program.programId.toBase58(),
    config: configPda.toBase58(),
    quoteMint: quoteMint.toBase58(),
    quoteDecimals: QUOTE_DECIMALS,
    markets: {
      [SYMBOL]: {
        mint: stockMint.toBase58(),
        market: marketPda.toBase58(),
        decimals: STOCK_DECIMALS,
        multiplier: MULTIPLIER,
        feeBps: FEE_BPS,
        mock: true,
      },
    },
    createdAt: new Date().toISOString(),
  };
  writeFileSync('devnet.json', JSON.stringify(out, null, 2) + '\n');

  log('');
  log('Wrote devnet.json');
  log(`Explorer: https://explorer.solana.com/address/${program.programId.toBase58()}?cluster=devnet`);
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
