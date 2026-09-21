/**
 * Initialize Rung on mainnet: real USDC as the quote mint, every live PreStock allowlisted.
 *
 *   bash scripts/wsl/run.sh node scripts/setup-mainnet.ts [--dry-run]
 *
 * Signs with ~/.config/solana/id.json, which becomes the protocol admin (it can list and
 * disable markets and pause new positions). Idempotent: an existing config is checked rather than re-created, and a
 * market that already exists is skipped, so a partial run can simply be run again.
 *
 * Each mint is re-read live before it is listed. The program already refuses a mint with a
 * transfer hook set; checking here too means the refusal is explained instead of surfacing
 * as a failed transaction, and a paused mint is flagged before anyone can escrow against it.
 *
 * RPC is MAINNET_RPC_URL (environment or .env.local), else public mainnet. Only the host is
 * printed, because paid RPC URLs carry their key in the query string.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  USDC_DECIMALS,
  USDC_MINT,
  fetchMintState,
  fetchPreStocks,
  rpcFromUrl,
} from '../packages/sdk/src/prestocks.ts';

const DRY_RUN = process.argv.includes('--dry-run');
// Enough to land promptly on a busy mainnet at negligible cost: these are tiny transactions.
const PRIORITY_MICROLAMPORTS = 100_000;

function envLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync('.env.local')) return out;
  for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const RPC = process.env.MAINNET_RPC_URL ?? envLocal().MAINNET_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))),
);
const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl;
const program = new Program(idl, new AnchorProvider(connection, new Wallet(payer), { commitment: 'confirmed' }));
const priority = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_MICROLAMPORTS })];

async function retry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // A program error will not change on retry; only transport failures are worth it.
      if (i === attempts || /custom program error|AnchorError|Error Code/.test(String(e))) break;
      console.log(`  ${label} failed (${e instanceof Error ? e.message : e}); retrying [${i}/${attempts - 1}]`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
  throw last;
}

async function main() {
  const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program.programId)[0];
  const configPda = pda([Buffer.from('config')]);
  const usdc = new PublicKey(USDC_MINT);

  console.log(`RPC      ${RPC.split('?')[0]}`);
  console.log(`Admin    ${payer.publicKey.toBase58()}  (${(await connection.getBalance(payer.publicKey)) / 1e9} SOL)`);
  console.log(`Program  ${program.programId.toBase58()}`);
  console.log(DRY_RUN ? 'Mode     dry run -- nothing will be sent\n' : '');

  const programInfo = await connection.getAccountInfo(program.programId);
  if (!programInfo?.executable) {
    if (!DRY_RUN) throw new Error('The program is not deployed on mainnet yet.');
    console.log('Program  not deployed yet (fine for a dry run)\n');
  }

  const existing = await connection.getAccountInfo(configPda);
  if (existing) {
    const config = await program.account.globalConfig.fetch(configPda);
    const quote = (config as { quoteMint: PublicKey }).quoteMint;
    if (!quote.equals(usdc)) throw new Error(`Config exists with quote mint ${quote.toBase58()}, not USDC`);
    console.log(`Config   exists, quote mint is USDC`);
  } else if (DRY_RUN) {
    console.log(`Config   would initialize ${configPda.toBase58()} with USDC`);
  } else {
    await retry('initializeConfig', () =>
      program.methods
        .initializeConfig()
        .accounts({ admin: payer.publicKey, config: configPda, quoteMint: usdc, quoteTokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
        .preInstructions(priority)
        .rpc(),
    );
    console.log(`Config   initialized ${configPda.toBase58()}`);
  }

  const assets = await fetchPreStocks();
  const rpc = rpcFromUrl(RPC);
  const markets: Record<string, { mint: string; market: string }> = {};
  console.log('');

  for (const asset of assets) {
    const mint = new PublicKey(asset.contract_address);
    const marketPda = pda([Buffer.from('market'), mint.toBuffer()]);
    const state = await retry(`read ${asset.symbol}`, () => fetchMintState(asset.contract_address, rpc));
    const label = asset.symbol.padEnd(10);

    if (state.tokenProgram !== TOKEN_2022_PROGRAM_ID.toBase58()) {
      console.log(`${label} SKIP: not a Token-2022 mint`);
      continue;
    }
    if (state.transferHookProgramId) {
      console.log(`${label} SKIP: transfer hook ${state.transferHookProgramId} is set; the program would refuse it`);
      continue;
    }
    const note = `fee ${state.transferFee.transferFeeBasisPoints}bps, multiplier ${state.multiplier}${state.paused ? ', PAUSED by issuer' : ''}`;

    if (await connection.getAccountInfo(marketPda)) {
      console.log(`${label} already listed  (${note})`);
    } else if (DRY_RUN) {
      console.log(`${label} would list ${mint.toBase58()}  (${note})`);
    } else {
      await retry(`addMarket ${asset.symbol}`, () =>
        program.methods
          .addMarket(asset.symbol)
          .accounts({ admin: payer.publicKey, config: configPda, market: marketPda, stockMint: mint, stockTokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId })
          .preInstructions(priority)
          .rpc(),
      );
      console.log(`${label} listed ${marketPda.toBase58()}  (${note})`);
    }
    markets[asset.symbol] = { mint: mint.toBase58(), market: marketPda.toBase58() };
  }

  if (DRY_RUN) {
    console.log('\nDry run: nothing sent, mainnet.json not written.');
    return;
  }
  writeFileSync(
    'mainnet.json',
    JSON.stringify(
      {
        cluster: 'mainnet-beta',
        programId: program.programId.toBase58(),
        config: configPda.toBase58(),
        quoteMint: USDC_MINT,
        quoteDecimals: USDC_DECIMALS,
        markets,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nWrote mainnet.json (${Object.keys(markets).length} markets)`);
  console.log(`Explorer: https://explorer.solana.com/address/${program.programId.toBase58()}`);
}

main().catch((e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e);
  if (e && typeof e === 'object' && 'logs' in e) console.error((e as { logs: string[] }).logs);
  process.exit(1);
});
