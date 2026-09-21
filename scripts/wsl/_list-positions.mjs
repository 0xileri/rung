// Every Position on the devnet deployment, oldest first.
//
//   bash scripts/wsl/run.sh node scripts/wsl/_list-positions.mjs
//
// Decodes through program.account, which camelCases field names. BorshAccountsCoder.decode
// returns the IDL's snake_case names, so reading `p.targetValuationUsd` off it yields
// undefined -> NaN; that is the bug which made open positions look missing. Public devnet is
// used so no API key is involved.
import { readFileSync } from 'node:fs';
import { AnchorProvider, Program, Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair } from '@solana/web3.js';
const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8'));
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const program = new Program(idl, new AnchorProvider(conn, new Wallet(Keypair.generate()), {}));
const all = await program.account.position.all();
for (const { publicKey, account: a } of all.sort((x, y) => x.account.createdAt.toNumber() - y.account.createdAt.toNumber())) {
  console.log([
    publicKey.toBase58().slice(0, 8),
    'maker ' + a.maker.toBase58().slice(0, 6),
    'taker ' + a.taker.toBase58().slice(0, 6),
    Object.keys(a.status)[0],
    '$' + (a.targetValuationUsd.toNumber() / 1e12).toFixed(3) + 'T',
    'strike $' + a.strikeQuoteAmount.toNumber() / 1e6,
    'prem $' + a.premiumQuoteAmount.toNumber() / 1e6,
    new Date(a.createdAt.toNumber() * 1000).toISOString().slice(0, 16),
  ].join('  '));
}
console.log(`${all.length} positions`);
