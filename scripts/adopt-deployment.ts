/**
 * Stand a freshly deployed program up over an existing deployment's mock mints.
 *
 *   bash scripts/wsl/run.sh node scripts/adopt-deployment.ts --from devnet.json --out devnet.json
 *   bash scripts/wsl/run.sh node scripts/adopt-deployment.ts --dry-run
 *
 * Rung runs two programs on devnet side by side: the one the Stocklana submission was judged
 * against, left exactly as it was, and the current one. They share the same mock USDC and the
 * same mock PreStocks, so the faucet, every funded test wallet and every balance work against
 * both — only the program, its config and its markets are new.
 *
 * This initializes the new program's config with the source deployment's quote mint, lists
 * every one of its markets, sets the protocol fee and minimum fill, and writes a deployment
 * file for the new program. Re-running is safe: anything already on chain is left alone.
 *
 * The program comes from the IDL (packages/sdk/idl/rung.json), which a build points at
 * whatever `declare_id!` says; the admin is ~/.config/solana/id.json, which must hold mint
 * authority over nothing here — adopting a mint does not need it.
 *
 * --fee-bps (default 100) and --min-fill USDC (default 10) are what the new config starts
 * with; both can be changed later with scripts/set-protocol-params.ts.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AnchorProvider, BN, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function envFile(): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync('.env.local')) {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  }
  return out;
}

const RPC = flag('rpc') ?? process.env.DEVNET_RPC_URL ?? envFile().DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const FROM = flag('from') ?? 'devnet.json';
const OUT = flag('out') ?? 'devnet.json';
const FEE_BPS = Number(flag('fee-bps') ?? 100);
const MIN_FILL_USD = Number(flag('min-fill') ?? 10);
const DRY_RUN = args.includes('--dry-run');
const host = (() => {
  try {
    return new URL(RPC).host;
  } catch {
    return 'rpc';
  }
})();

async function main() {
  const source = JSON.parse(readFileSync(FROM, 'utf8')) as {
    cluster: string;
    quoteMint: string;
    quoteDecimals: number;
    markets: Record<string, { mint: string; decimals: number; multiplier: number; feeBps: number; mock: boolean }>;
  };
  const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl;
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))),
  );
  const connection = new Connection(RPC, 'confirmed');
  const program = new Program(idl, new AnchorProvider(connection, new Wallet(admin), { commitment: 'confirmed' }));
  const programId = program.programId;
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const config = pda([Buffer.from('config')]);
  const quoteMint = new PublicKey(source.quoteMint);

  console.log(`RPC       ${host}`);
  console.log(`Program   ${programId.toBase58()}`);
  console.log(`Admin     ${admin.publicKey.toBase58()}`);
  console.log(`Source    ${FROM} (${Object.keys(source.markets).length} markets, quote ${source.quoteMint})`);

  const programInfo = await connection.getAccountInfo(programId);
  if (!programInfo?.executable) throw new Error(`${programId.toBase58()} is not deployed on ${host}; deploy it first`);
  if (source.markets && Object.values(source.markets).some((m) => !m.mock)) {
    throw new Error('the source lists real mints; adopting is only for mock deployments');
  }

  // Config: create once, then leave it alone except for the two parameters below.
  if (await connection.getAccountInfo(config)) {
    console.log(`\nConfig    ${config.toBase58()} (exists)`);
  } else if (DRY_RUN) {
    console.log(`\nConfig    ${config.toBase58()} (would create)`);
  } else {
    await program.methods
      .initializeConfig()
      .accounts({ admin: admin.publicKey, config, quoteMint, quoteTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId } as never)
      .rpc();
    console.log(`\nConfig    ${config.toBase58()} (created)`);
  }

  const markets: Record<string, unknown> = {};
  for (const [symbol, m] of Object.entries(source.markets)) {
    const mint = new PublicKey(m.mint);
    const market = pda([Buffer.from('market'), mint.toBuffer()]);
    markets[symbol] = { ...m, market: market.toBase58() };
    if (await connection.getAccountInfo(market)) {
      console.log(`Market    ${symbol.padEnd(10)} ${market.toBase58()} (exists)`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`Market    ${symbol.padEnd(10)} ${market.toBase58()} (would list)`);
      continue;
    }
    await program.methods
      .addMarket(symbol)
      .accounts({ admin: admin.publicKey, config, market, stockMint: mint, stockTokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId } as never)
      .rpc();
    console.log(`Market    ${symbol.padEnd(10)} ${market.toBase58()} (listed)`);
  }

  if (!DRY_RUN) {
    await program.methods
      .setFee(FEE_BPS)
      .accounts({ admin: admin.publicKey, config, feeTreasury: admin.publicKey } as never)
      .rpc();
    await program.methods
      .setMinFill(new BN(Math.round(MIN_FILL_USD * 1e6)))
      .accounts({ admin: admin.publicKey, config } as never)
      .rpc();
    console.log(`\nFee       ${FEE_BPS}bps of the premium, to ${admin.publicKey.toBase58()}`);
    console.log(`Min fill  ${MIN_FILL_USD} USDC`);

    const out = {
      ...source,
      note:
        'The current Rung program, over the same mock mints as the Stocklana deployment (which still runs ' +
        'its own program, unchanged). PreStocks exist only on mainnet: every stock mint here is a MOCK that ' +
        'reproduces its real counterpart’s transfer fee and scaled-amount extensions. Valuation data ' +
        'remains live from the real PreStocks API.',
      programId: programId.toBase58(),
      config: config.toBase58(),
      markets,
      adoptedFrom: { file: FROM, at: new Date().toISOString() },
    };
    writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(`\nWrote ${OUT}`);
  }
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
