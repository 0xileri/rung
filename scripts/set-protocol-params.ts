/**
 * Set the protocol fee and the minimum fill, as the config's admin.
 *
 *   bash scripts/wsl/run.sh node scripts/set-protocol-params.ts --fee-bps 100 --min-fill 10
 *   bash scripts/wsl/run.sh node scripts/set-protocol-params.ts --fee-bps 0
 *
 * Both are deliberately separate from deployment. A protocol that starts charging the moment
 * it is deployed has decided something on its users' behalf; these are set knowingly, and
 * printed back so the rate in force is never a matter of belief.
 *
 * --treasury sets where the fee is paid, defaulting to the admin's own address. The fee comes
 * out of the premium, never out of escrowed collateral, so nothing here can make an existing
 * position unsettleable — but it does change what a maker receives on their next match, which
 * is why the change is announced rather than silent.
 *
 * Reads the cluster from DEVNET_RPC_URL (or --rpc), and the deployment from DEPLOYMENT_FILE.
 */
import { readFileSync, existsSync } from 'node:fs';
import { AnchorProvider, BN, Program, Wallet, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

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

const rpc =
  flag('rpc') ?? process.env.DEVNET_RPC_URL ?? envFile().DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const deploymentFile = process.env.DEPLOYMENT_FILE ?? 'devnet.json';

async function main() {
  const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));
  const idl = JSON.parse(readFileSync('packages/sdk/idl/rung.json', 'utf8')) as Idl;
  const admin = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, 'utf8'))),
  );
  const connection = new Connection(rpc, 'confirmed');
  const provider = new AnchorProvider(connection, new Wallet(admin), { commitment: 'confirmed' });
  const program = new Program(idl, provider);
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);

  const before = (await (program.account as any).globalConfig.fetch(configPda)) as {
    admin: PublicKey;
    feeBps: number;
    feeTreasury: PublicKey;
    minFillQuote: { toString(): string };
  };
  // Only the recorded admin can change these; saying so up front beats a raw constraint error.
  if (!before.admin.equals(admin.publicKey)) {
    throw new Error(
      `${admin.publicKey.toBase58()} is not the config admin (${before.admin.toBase58()}) on ${new URL(rpc).host}`,
    );
  }

  console.log(`RPC        ${new URL(rpc).host}`);
  console.log(`Config     ${configPda.toBase58()}`);
  console.log(`Currently  fee ${before.feeBps}bps → ${before.feeTreasury.toBase58()}`);
  console.log(`           min fill ${Number(before.minFillQuote.toString()) / 1e6} USDC`);

  const feeBps = flag('fee-bps');
  if (feeBps !== undefined) {
    const treasury = new PublicKey(flag('treasury') ?? admin.publicKey.toBase58());
    const sig = await program.methods
      .setFee(Number(feeBps))
      .accounts({ admin: admin.publicKey, config: configPda, feeTreasury: treasury })
      .rpc();
    console.log(`\nFee        ${feeBps}bps of the premium → ${treasury.toBase58()}`);
    console.log(`           ${sig}`);
  }

  const minFill = flag('min-fill');
  if (minFill !== undefined) {
    const raw = new BN(Math.round(Number(minFill) * 1e6));
    const sig = await program.methods
      .setMinFill(raw)
      .accounts({ admin: admin.publicKey, config: configPda })
      .rpc();
    console.log(`\nMin fill   ${minFill} USDC, and the smallest remainder a fill may leave`);
    console.log(`           ${sig}`);
  }

  if (feeBps === undefined && minFill === undefined) {
    console.log('\nNothing changed. Pass --fee-bps and/or --min-fill.');
  }
}

main().catch((e) => {
  console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
