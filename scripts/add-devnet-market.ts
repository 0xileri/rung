/**
 * List another PreStock on devnet, against a mock that mirrors the real mint.
 *
 *   bash scripts/wsl/run.sh node scripts/add-devnet-market.ts SPACEX
 *
 * PreStocks exist only on mainnet, so each devnet market escrows a mock. This one is built
 * from the live mint rather than from constants: its decimals, the multiplier active right
 * now, and the transfer fee active right now are read from mainnet. It also carries an
 * empty transfer-hook slot, as every real PreStock does, so the program's hook guard is
 * exercised on devnet too (an empty slot must be accepted).
 *
 * Idempotent: a market already recorded in devnet.json whose mint exists is left alone.
 * Signs with the deployer, which is the protocol admin and the mock's authorities.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { AnchorProvider, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  getMintLen,
} from '@solana/spl-token';
import { fetchMintState, fetchPreStock, rpcFromUrl } from '../packages/sdk/src/prestocks.ts';

const SYMBOL = (process.argv[2] ?? '').toUpperCase();
const DEVNET = process.env.SEED_RPC_URL ?? 'https://api.devnet.solana.com';
const MAINNET = process.env.MAINNET_READ_RPC_URL ?? 'https://api.mainnet-beta.solana.com';

async function main() {
  if (!SYMBOL) throw new Error('usage: add-devnet-market.ts <SYMBOL>');
  const deployment = JSON.parse(readFileSync('devnet.json', 'utf8'));
  const conn = new Connection(DEVNET, 'confirmed');
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))),
  );
  const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl;
  const program = new Program(idl, new AnchorProvider(conn, new Wallet(payer), { commitment: 'confirmed' }));

  const existing = deployment.markets?.[SYMBOL];
  if (existing && (await conn.getAccountInfo(new PublicKey(existing.mint)))) {
    console.log(`${SYMBOL} is already listed on devnet: ${existing.mint}`);
    return;
  }

  const asset = await fetchPreStock(SYMBOL);
  const real = await fetchMintState(asset.contract_address, rpcFromUrl(MAINNET));
  const feeBps = real.transferFee.transferFeeBasisPoints;
  console.log(`Real ${SYMBOL}: ${real.decimals} decimals, multiplier ${real.multiplier}, fee ${feeBps}bps`);

  const mintKp = Keypair.generate();
  const len = getMintLen([ExtensionType.TransferFeeConfig, ExtensionType.ScaledUiAmountConfig, ExtensionType.TransferHook]);
  const lamports = await conn.getMinimumBalanceForRentExemption(len);
  // Every extension must be initialized before initializeMint, or the mint is rejected.
  await sendAndConfirmTransaction(
    conn,
    new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey, space: len, lamports, programId: TOKEN_2022_PROGRAM_ID }),
      createInitializeTransferFeeConfigInstruction(mintKp.publicKey, payer.publicKey, payer.publicKey, feeBps, BigInt('18446744073709551615'), TOKEN_2022_PROGRAM_ID),
      createInitializeScaledUiAmountConfigInstruction(mintKp.publicKey, payer.publicKey, real.multiplier, TOKEN_2022_PROGRAM_ID),
      // Empty, like every real PreStock's: the slot exists, no program is set.
      createInitializeTransferHookInstruction(mintKp.publicKey, payer.publicKey, PublicKey.default, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(mintKp.publicKey, real.decimals, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    ),
    [payer, mintKp],
    { commitment: 'confirmed' },
  );
  console.log(`Mock mint ${mintKp.publicKey.toBase58()}`);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);
  const [market] = PublicKey.findProgramAddressSync([Buffer.from('market'), mintKp.publicKey.toBuffer()], program.programId);
  await program.methods
    .addMarket(SYMBOL)
    .accounts({ admin: payer.publicKey, config, market, stockMint: mintKp.publicKey, stockTokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId })
    .rpc();
  console.log(`Listed    ${market.toBase58()}`);

  deployment.markets = {
    ...deployment.markets,
    [SYMBOL]: {
      mint: mintKp.publicKey.toBase58(),
      market: market.toBase58(),
      decimals: real.decimals,
      multiplier: real.multiplier,
      feeBps,
      mock: true,
    },
  };
  writeFileSync('devnet.json', JSON.stringify(deployment, null, 2) + '\n');
  console.log('Updated devnet.json');
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  if (e && typeof e === 'object' && 'logs' in e) console.error((e as { logs: string[] }).logs?.join('\n'));
  process.exit(1);
});
