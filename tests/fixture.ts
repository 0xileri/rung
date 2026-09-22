import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createMint } from '@solana/spl-token';
import { Rung } from '../target/types/rung';

/**
 * State every suite has to share.
 *
 * `GlobalConfig` is a single PDA holding the one settlement currency, so two suites cannot
 * each initialize it with a quote mint of their own: the second would either fail to create
 * it or find every commitment rejected for the wrong mint. They share this instead, and keep
 * only what is genuinely per-suite — their own stock mint and market — to themselves.
 */
export type Shared = {
  provider: anchor.AnchorProvider;
  program: Program<Rung>;
  connection: anchor.web3.Connection;
  admin: anchor.web3.Keypair;
  quoteMint: PublicKey;
  configPda: PublicKey;
};

let shared: Promise<Shared> | null = null;

export function getShared(): Promise<Shared> {
  shared ??= (async () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.Rung as Program<Rung>;
    const connection = provider.connection;
    const admin = (provider.wallet as anchor.Wallet).payer;
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], program.programId);

    const existing = await program.account.globalConfig.fetchNullable(configPda);
    if (existing) {
      return { provider, program, connection, admin, quoteMint: existing.quoteMint, configPda };
    }

    // USDC stand-in: legacy SPL Token, no extensions, exactly like the real thing.
    const quoteMint = await createMint(connection, admin, admin.publicKey, null, 6, undefined, undefined, TOKEN_PROGRAM_ID);
    await program.methods
      .initializeConfig()
      .accounts({
        admin: admin.publicKey,
        config: configPda,
        quoteMint,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { provider, program, connection, admin, quoteMint, configPda };
  })();
  return shared;
}

/**
 * Fund a test keypair, working on either a local validator or devnet.
 *
 * A local validator airdrops instantly and without limit, which is the fast path. Devnet's
 * faucet is capped per request and rate-limited across them, so there the airdrop fails and
 * we pay out of the provider wallet instead — which is funded once, out of band. Trying both
 * means a suite does not care which cluster it is pointed at.
 */
export async function fund(s: Shared, to: PublicKey, sol: number) {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  try {
    const sig = await s.connection.requestAirdrop(to, lamports);
    await s.connection.confirmTransaction(sig, 'confirmed');
    return;
  } catch {
    // Expected on devnet; fall through to paying from the provider wallet.
  }
  await s.provider.sendAndConfirm(
    new anchor.web3.Transaction().add(
      SystemProgram.transfer({ fromPubkey: s.admin.publicKey, toPubkey: to, lamports }),
    ),
    [],
  );
}
