import { Transaction, type Connection, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { explainError } from './program';

/**
 * Batch several instructions into as few transactions as fit, sign them together, and send
 * them in order.
 *
 * Used wherever one action is really several independent instructions: a sweep across
 * floors, settling every expired claim on a book. Packing is by MEASURED size rather than a
 * guessed count — the limit is bytes, and how many instructions fit depends on how many
 * accounts they share — and each transaction stands on its own, so a failure partway leaves
 * the earlier ones landed rather than unwinding them. The result says exactly which.
 */

/** Solana's packet limit, less a margin for the signatures a wallet adds. */
const MAX_TX_BYTES = 1150;

export function packInstructions(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  blockhash: string,
): Transaction[] {
  const size = (ixs: TransactionInstruction[]) => {
    const probe = new Transaction();
    probe.recentBlockhash = blockhash;
    probe.feePayer = feePayer;
    ixs.forEach((ix) => probe.add(ix));
    return probe.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  };

  const out: Transaction[] = [];
  let current: TransactionInstruction[] = [];
  for (const ix of instructions) {
    if (current.length > 0 && size([...current, ix]) > MAX_TX_BYTES) {
      out.push(new Transaction().add(...current));
      current = [ix];
    } else {
      current.push(ix);
    }
  }
  if (current.length > 0) out.push(new Transaction().add(...current));

  for (const tx of out) {
    tx.recentBlockhash = blockhash;
    tx.feePayer = feePayer;
  }
  return out;
}

export type PackedResult = {
  signatures: string[];
  /** How many of the input instructions landed, counted from the start. */
  landed: number;
  /** Why sending stopped, if it did. */
  failure: string | null;
};

type Signer = {
  publicKey: PublicKey | null;
  signAllTransactions?: <T extends Transaction>(txs: T[]) => Promise<T[]>;
};

export async function signAndSendPacked(
  connection: Connection,
  wallet: Signer,
  instructions: TransactionInstruction[],
  onProgress: (note: string) => void = () => {},
): Promise<PackedResult> {
  if (!wallet.publicKey || !wallet.signAllTransactions) {
    return { signatures: [], landed: 0, failure: 'This wallet cannot sign several transactions at once.' };
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const transactions = packInstructions(instructions, wallet.publicKey, blockhash);

  onProgress('Waiting for your signature');
  const signed = await wallet.signAllTransactions(transactions);

  const signatures: string[] = [];
  let landed = 0;
  for (const [i, tx] of signed.entries()) {
    try {
      onProgress(signed.length > 1 ? `Confirming ${i + 1} of ${signed.length}` : 'Confirming on chain');
      const signature = await connection.sendRawTransaction(tx.serialize());
      const { value } = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (value.err) throw new Error(`Transaction failed: ${JSON.stringify(value.err)}`);
      signatures.push(signature);
      landed += transactions[i].instructions.length;
    } catch (err) {
      return { signatures, landed, failure: explainError(err) };
    }
  }
  return { signatures, landed, failure: null };
}
