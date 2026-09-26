/**
 * The keeper: settle every claim that has run past its deadline, for everyone.
 *
 *   bash scripts/wsl/run.sh node scripts/keeper.ts --once            # one pass, for cron
 *   bash scripts/wsl/run.sh node scripts/keeper.ts --watch 60        # loop every 60s
 *   bash scripts/wsl/run.sh node scripts/keeper.ts --once --dry-run  # list what is due
 *
 * Settlement after a deadline is permissionless on Rung, so no one depends on a counterparty
 * coming back — and no one depends on this keeper either. It only saves people the trouble:
 * the maker's USDC and the holder's tokens come home without either of them doing anything.
 * The book's "Settle all" button does the same thing by hand.
 *
 * What it can and cannot do. It sends one instruction, `expire_fill`, which the program
 * refuses before the deadline and which pays each side only what that fill records. A keeper
 * with a bug can waste its own fees; it cannot move anyone's collateral anywhere but home.
 *
 * Each cycle:
 *   1. read the cluster's clock (the program's clock, not this machine's — devnet drifts);
 *   2. fetch only fills still Matched, filtered on chain by their status byte, whose offset
 *      is derived from the IDL rather than hard-coded, so a layout change fails loudly;
 *   3. read the commitments they belong to, and pick the due ones, most overdue first
 *      (the SDK's dueForSettlement, which mirrors the program's own check);
 *   4. pack settlements into as few transactions as fit, simulate, send and confirm. If a
 *      packed transaction fails — a holder exercised in the meantime — its fills are retried
 *      one at a time, so one race can never hold up everyone else's collateral.
 *
 * Config, flags first then environment:
 *   --rpc / KEEPER_RPC_URL (else DEVNET_RPC_URL from .env.local, else public devnet)
 *   --keypair / KEEPER_KEYPAIR (else ~/.config/solana/id.json) — pays fees and any rent for
 *   a recipient's missing token account; nothing else.
 *   KEEPER_SECRET_KEY — the key itself, as the keypair file's JSON array, for a host with no
 *   file to point at (the Railway cron job; see the README). A file named above wins.
 *   --limit N settlements per cycle (default 50)
 */
import { existsSync, readFileSync } from 'node:fs';
import { AnchorProvider, BorshAccountsCoder, Program, Wallet, utils, type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { dueForSettlement, type DueSettlement } from '../packages/sdk/src/keeper.ts';

// Anchor's re-export: bs58 is not a direct dependency of this repo, so importing it by name
// would break the day Anchor stopped pulling it in.
const bs58 = utils.bytes.bs58;

/* ------------------------------------------------------------------ config */

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

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

const RPC = flag('rpc') ?? process.env.KEEPER_RPC_URL ?? envFile().DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const KEYPAIR = flag('keypair') ?? process.env.KEEPER_KEYPAIR;
const SECRET_KEY = process.env.KEEPER_SECRET_KEY;
const DRY_RUN = has('dry-run');
const WATCH = has('watch') ? Number(flag('watch') ?? 60) : null;
const LIMIT = Number(flag('limit') ?? 50);
/** Solana's packet limit, less a margin. The keeper is the only signer. */
const MAX_TX_BYTES = 1200;

// Only the host is ever printed: paid RPC URLs carry their key in the query string.
const host = (() => {
  try {
    return new URL(RPC).host;
  } catch {
    return 'rpc';
  }
})();
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = (...m: unknown[]) => console.log(stamp(), ...m);

/* ------------------------------------------------------------------ chain */

const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl & {
  accounts: { name: string; discriminator: number[] }[];
  types: { name: string; type: { kind: string; fields?: { name: string; type: unknown }[] } }[];
};
const keeper = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(
      KEYPAIR
        ? readFileSync(KEYPAIR, 'utf8')
        : (SECRET_KEY ?? readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8')),
    ),
  ),
);
const connection = new Connection(RPC, 'confirmed');
const program = new Program(idl, new AnchorProvider(connection, new Wallet(keeper), { commitment: 'confirmed' }));
const coder = new BorshAccountsCoder(idl);
const PROGRAM_ID = program.programId;

/**
 * Byte offset of a field inside an account, from the IDL.
 *
 * Only fixed-size fields may precede it; anything else throws, because a guessed offset
 * would make the status filter quietly match the wrong byte and the keeper would find
 * nothing to do — which looks exactly like a quiet day.
 */
function fieldOffset(account: string, field: string): number {
  const def = idl.types.find((t) => t.name === account);
  if (!def?.type.fields) throw new Error(`IDL has no struct ${account}`);
  const size: Record<string, number> = { pubkey: 32, u8: 1, i8: 1, bool: 1, u16: 2, i16: 2, u32: 4, i32: 4, u64: 8, i64: 8 };
  let offset = 8; // discriminator
  for (const f of def.type.fields) {
    if (f.name === field) return offset;
    const bytes = typeof f.type === 'string' ? size[f.type] : undefined;
    if (bytes === undefined) throw new Error(`${account}.${f.name} is not fixed-size; cannot place ${field}`);
    offset += bytes;
  }
  throw new Error(`IDL struct ${account} has no field ${field}`);
}

const discriminator = (name: string) => {
  const d = idl.accounts.find((a) => a.name === name)?.discriminator;
  if (!d) throw new Error(`IDL has no account ${name}`);
  return bs58.encode(Uint8Array.from(d));
};

/** The cluster's own unix time, from the Clock sysvar — what the program checks against. */
async function clusterNow(): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed');
  if (!info) throw new Error('Clock sysvar unavailable');
  return Number(info.data.readBigInt64LE(32));
}

type FillAccount = { pubkey: PublicKey; taker: PublicKey; position: PublicKey; strikeQuoteAmount: bigint };
type PositionAccount = {
  pubkey: PublicKey;
  maker: PublicKey;
  stockMint: PublicKey;
  quoteMint: PublicKey;
  stockTokenProgram: PublicKey;
  quoteTokenProgram: PublicKey;
  expiryTs: number;
};

/**
 * A decoded field under either spelling. The raw coder keeps the IDL's snake_case names
 * (`strike_quote_amount`); Anchor's fetch converts them. Reading both, as the web app does,
 * means a decoder change cannot turn every figure into undefined.
 */
function field<T = any>(obj: Record<string, any>, snake: string): T {
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const v = obj[snake] ?? obj[camel];
  if (v === undefined) throw new Error(`decoded account has no ${snake}`);
  return v as T;
}

const FILL_STATUS_OFFSET = fieldOffset('Fill', 'status');

/** Borsh encodes a unit enum as its variant index, so the byte to match is Matched's index. */
const MATCHED = (() => {
  const def = idl.types.find((t) => t.name === 'FillStatus') as { type: { variants?: { name: string }[] } } | undefined;
  const index = def?.type.variants?.findIndex((v) => v.name === 'Matched') ?? -1;
  if (index < 0) throw new Error('IDL has no FillStatus::Matched');
  return bs58.encode(Uint8Array.from([index]));
})();

async function matchedFills(): Promise<FillAccount[]> {
  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [
      { memcmp: { offset: 0, bytes: discriminator('Fill') } },
      { memcmp: { offset: FILL_STATUS_OFFSET, bytes: MATCHED } },
    ],
  });
  return accounts.map(({ pubkey, account }) => {
    const f = coder.decode('Fill', account.data) as Record<string, any>;
    // Belt and braces: the on-chain filter picked these by one byte. Decoding confirms it
    // was the right byte, rather than trusting the offset arithmetic silently. The raw coder
    // names variants as the IDL does ("Matched"), unlike Anchor's fetch ("matched"), so the
    // comparison ignores case.
    const variant = Object.keys(f.status)[0]?.toLowerCase();
    if (variant !== 'matched') throw new Error(`status filter matched a ${variant} fill ${pubkey.toBase58()}`);
    return {
      pubkey,
      taker: field<PublicKey>(f, 'taker'),
      position: field<PublicKey>(f, 'position'),
      strikeQuoteAmount: BigInt(field(f, 'strike_quote_amount').toString()),
    };
  });
}

async function readPositions(keys: PublicKey[]): Promise<Map<string, PositionAccount>> {
  const out = new Map<string, PositionAccount>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk, 'confirmed');
    infos.forEach((info, j) => {
      if (!info) return;
      const p = coder.decode('Position', info.data) as Record<string, any>;
      out.set(chunk[j].toBase58(), {
        pubkey: chunk[j],
        maker: field(p, 'maker'),
        stockMint: field(p, 'stock_mint'),
        quoteMint: field(p, 'quote_mint'),
        stockTokenProgram: field(p, 'stock_token_program'),
        quoteTokenProgram: field(p, 'quote_token_program'),
        expiryTs: Number(field(p, 'expiry_ts').toString()),
      });
    });
  }
  return out;
}

async function expireIx(fill: FillAccount, p: PositionAccount): Promise<TransactionInstruction> {
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from('position_authority'), p.pubkey.toBuffer()],
    PROGRAM_ID,
  );
  const ata = (mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  return program.methods
    .expireFill()
    .accounts({
      cranker: keeper.publicKey,
      position: p.pubkey,
      fill: fill.pubkey,
      maker: p.maker,
      taker: fill.taker,
      positionAuthority: authority,
      stockMint: p.stockMint,
      quoteMint: p.quoteMint,
      quoteVault: ata(p.quoteMint, authority, p.quoteTokenProgram),
      stockVault: ata(p.stockMint, authority, p.stockTokenProgram),
      makerQuoteAccount: ata(p.quoteMint, p.maker, p.quoteTokenProgram),
      takerStockAccount: ata(p.stockMint, fill.taker, p.stockTokenProgram),
      stockTokenProgram: p.stockTokenProgram,
      quoteTokenProgram: p.quoteTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as never)
    .instruction();
}

/* ------------------------------------------------------------------ sending */

function pack(ixs: { ix: TransactionInstruction; due: DueSettlement }[], blockhash: string) {
  const size = (group: TransactionInstruction[]) => {
    const tx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash });
    group.forEach((ix) => tx.add(ix));
    // serialize() throws, rather than returning a length, once past the packet limit; that
    // throw is the answer "does not fit", not an error.
    try {
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    } catch {
      return Infinity;
    }
  };
  const groups: (typeof ixs)[] = [];
  let current: typeof ixs = [];
  for (const item of ixs) {
    if (current.length && size([...current, item].map((c) => c.ix)) > MAX_TX_BYTES) {
      groups.push(current);
      current = [item];
    } else {
      current.push(item);
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/** The program's own words for a failure, not the RPC's wrapper around them. */
function reason(err: unknown, logs?: string[] | null): string {
  const fromLogs = logs?.find((l) => l.includes('Error Message:') || l.includes('AnchorError'));
  if (fromLogs) return fromLogs.replace(/^Program log: /, '');
  return (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 160);
}

async function sendGroup(group: { ix: TransactionInstruction; due: DueSettlement }[]) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: keeper.publicKey, recentBlockhash: blockhash });
  group.forEach(({ ix }) => tx.add(ix));
  tx.sign(keeper);

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) return { ok: false as const, error: reason(sim.value.err, sim.value.logs) };

  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (value.err) return { ok: false as const, error: `landed but failed: ${JSON.stringify(value.err)}` };
  return { ok: true as const, signature };
}

/* ------------------------------------------------------------------ cycle */

type CycleResult = { due: number; settled: number; failed: number; returnedQuote: bigint };

async function cycle(): Promise<CycleResult> {
  const [now, fills] = await Promise.all([clusterNow(), matchedFills()]);
  const positions = await readPositions([...new Set(fills.map((f) => f.position.toBase58()))].map((k) => new PublicKey(k)));
  const due = dueForSettlement(
    fills.map((f) => ({ fill: f.pubkey.toBase58(), position: f.position.toBase58(), status: 'Matched' as const, strikeQuoteAmount: f.strikeQuoteAmount })),
    [...positions.values()].map((p) => ({ position: p.pubkey.toBase58(), expiryTs: p.expiryTs })),
    now,
    LIMIT,
  );

  if (due.length === 0) {
    log(`${fills.length} running claim${fills.length === 1 ? '' : 's'}, none past deadline`);
    return { due: 0, settled: 0, failed: 0, returnedQuote: 0n };
  }
  log(`${due.length} claim${due.length === 1 ? '' : 's'} past deadline (oldest ${Math.round(due[0].overdue / 60)} min overdue)`);

  const byFill = new Map(fills.map((f) => [f.pubkey.toBase58(), f]));
  if (DRY_RUN) {
    for (const d of due) log(`  would settle ${d.fill}  ${Number(d.strikeQuoteAmount) / 1e6} USDC  ${d.overdue}s overdue`);
    return { due: due.length, settled: 0, failed: 0, returnedQuote: 0n };
  }

  const items = await Promise.all(
    due.map(async (d) => ({ due: d, ix: await expireIx(byFill.get(d.fill)!, positions.get(d.position)!) })),
  );
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  let settled = 0;
  let failed = 0;
  let returnedQuote = 0n;
  const land = (group: typeof items, signature: string) => {
    settled += group.length;
    for (const g of group) returnedQuote += g.due.strikeQuoteAmount;
    log(`  settled ${group.length}: ${signature}`);
  };

  for (const group of pack(items, blockhash)) {
    const result = await sendGroup(group);
    if (result.ok) {
      land(group, result.signature);
      continue;
    }
    if (group.length === 1) {
      failed += 1;
      log(`  could not settle ${group[0].due.fill}: ${result.error}`);
      continue;
    }
    // Something in the batch no longer settles — most likely a holder exercised between our
    // read and our send. Take the batch apart so the others still go through.
    log(`  batch of ${group.length} failed (${result.error}); retrying one at a time`);
    for (const single of group) {
      const one = await sendGroup([single]);
      if (one.ok) land([single], one.signature);
      else {
        failed += 1;
        log(`  could not settle ${single.due.fill}: ${one.error}`);
      }
    }
  }

  log(`settled ${settled} of ${due.length}; ${(Number(returnedQuote) / 1e6).toFixed(2)} USDC back to makers, tokens back to holders`);
  return { due: due.length, settled, failed, returnedQuote };
}

/* ------------------------------------------------------------------ main */

async function main() {
  const balance = await connection.getBalance(keeper.publicKey);
  log(`keeper ${keeper.publicKey.toBase58()} on ${host}, ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  log(`program ${PROGRAM_ID.toBase58()}; Fill.status at byte ${FILL_STATUS_OFFSET}${DRY_RUN ? '; DRY RUN' : ''}`);
  if (balance < 0.01 * LAMPORTS_PER_SOL && !DRY_RUN) {
    log('warning: under 0.01 SOL. Each settlement costs a fee, and rent if a recipient has no token account.');
  }

  if (WATCH === null) {
    const r = await cycle();
    process.exitCode = r.failed > 0 ? 2 : 0;
    return;
  }

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    log('stopping after this cycle (Ctrl-C again to quit now)');
  });

  // Back off on errors (a rate-limited RPC, a network blip) rather than hammering; recover
  // to the normal interval as soon as a cycle succeeds.
  let delay = WATCH;
  while (!stopping) {
    try {
      await cycle();
      delay = WATCH;
    } catch (e) {
      delay = Math.min(delay * 2, 300);
      log(`cycle failed: ${e instanceof Error ? e.message : String(e)}; next try in ${delay}s`);
    }
    for (let waited = 0; waited < delay && !stopping; waited++) await new Promise((r) => setTimeout(r, 1000));
  }
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
