/**
 * The single place that knows the shape of PreStocks' API and of a PreStock mint.
 *
 * Nothing above this layer should reach for raw API fields or raw extension state: the two
 * live-data traps (which multiplier is active, which fee slot is active) are resolved here
 * once, so callers can only ever see the resolved values.
 */

import {
  activeMultiplier, activeTransferFee,
  type ScaledUiAmountConfig, type TransferFee, type TransferFeeConfig,
} from './token2022.ts';
import type { PreStockAsset } from './valuation.ts';

export const PRESTOCKS_API = 'https://prestocks.com/api/prestocks';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_DECIMALS = 6;

/** PreStocks mints are Token-2022; USDC is still the legacy SPL Token program. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export async function fetchPreStocks(fetchImpl: typeof fetch = fetch): Promise<PreStockAsset[]> {
  const res = await fetchImpl(PRESTOCKS_API);
  if (!res.ok) throw new Error(`PreStocks API ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error('PreStocks API did not return an array');
  return body as PreStockAsset[];
}

export async function fetchPreStock(
  symbol: string, fetchImpl: typeof fetch = fetch,
): Promise<PreStockAsset> {
  const found = (await fetchPreStocks(fetchImpl)).find(
    (a) => a.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  if (!found) throw new Error(`No PreStock named ${symbol}`);
  return found;
}

/** Everything about a mint that the pricing and escrow paths depend on. */
export type MintState = {
  mint: string;
  decimals: number;
  tokenProgram: string;
  /** Already resolved for the current time — never the stale `multiplier` field. */
  multiplier: number;
  /** Already resolved for the current epoch. Use this to DISPLAY the live fee. */
  transferFee: TransferFee;
  /**
   * Both slots of the schedule. Use `worstCaseTransferFee` on this to SIZE a transfer: a
   * quote built now may be signed after an epoch rollover, when the other slot is live.
   */
  transferFeeConfig: TransferFeeConfig;
  /** Issuer capabilities that qualify any collateralization claim. */
  permanentDelegate: string | null;
  freezeAuthority: string | null;
  paused: boolean;
  transferHookProgramId: string | null;
};

type RpcCall = (method: string, params: unknown[]) => Promise<any>;

export function rpcFromUrl(url: string): RpcCall {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  };
}

const ext = (exts: any[], name: string) => exts.find((e) => e.extension === name)?.state;

/**
 * Read a mint and collapse its extensions into the resolved values callers need.
 *
 * Deliberately reads the epoch in the same pass: the fee slot cannot be chosen without it,
 * and inferring the epoch from wall-clock time would be guesswork.
 */
export async function fetchMintState(mint: string, rpc: RpcCall): Promise<MintState> {
  const [account, epochInfo] = await Promise.all([
    rpc('getAccountInfo', [mint, { encoding: 'jsonParsed' }]),
    rpc('getEpochInfo', []),
  ]);
  if (!account?.value) throw new Error(`Mint ${mint} not found`);

  const info = account.value.data.parsed.info;
  const exts: any[] = info.extensions ?? [];

  const scaleCfg = ext(exts, 'scaledUiAmountConfig');
  const multiplier = scaleCfg
    ? activeMultiplier(
        {
          multiplier: Number(scaleCfg.multiplier),
          newMultiplier: Number(scaleCfg.newMultiplier),
          newMultiplierEffectiveTimestamp: Number(scaleCfg.newMultiplierEffectiveTimestamp),
        } satisfies ScaledUiAmountConfig,
        Math.floor(Date.now() / 1000),
      )
    : 1;

  const feeCfg = ext(exts, 'transferFeeConfig');
  const toFee = (f: any): TransferFee => ({
    epoch: BigInt(f.epoch),
    transferFeeBasisPoints: Number(f.transferFeeBasisPoints),
    maximumFee: BigInt(f.maximumFee),
  });
  const noFee: TransferFee = { epoch: 0n, transferFeeBasisPoints: 0, maximumFee: 0n };
  const transferFeeConfig: TransferFeeConfig = feeCfg
    ? {
        olderTransferFee: toFee(feeCfg.olderTransferFee),
        newerTransferFee: toFee(feeCfg.newerTransferFee),
      }
    : { olderTransferFee: noFee, newerTransferFee: noFee };
  const transferFee = activeTransferFee(transferFeeConfig, BigInt(epochInfo.epoch));

  return {
    mint,
    decimals: Number(info.decimals),
    tokenProgram: account.value.owner,
    multiplier,
    transferFee,
    transferFeeConfig,
    permanentDelegate: ext(exts, 'permanentDelegate')?.delegate ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    paused: Boolean(ext(exts, 'pausableConfig')?.paused),
    transferHookProgramId: ext(exts, 'transferHook')?.programId ?? null,
  };
}

/**
 * Issuer powers that make an unqualified "fully collateralized" claim untrue.
 * Surfaced so the UI can disclose them rather than quietly dropping them.
 */
export function custodyCaveats(state: MintState): string[] {
  const out: string[] = [];
  if (state.permanentDelegate)
    out.push(`Issuer holds permanent delegate (${state.permanentDelegate}) and can move escrowed tokens out of the vault.`);
  if (state.freezeAuthority)
    out.push(`Issuer holds freeze authority (${state.freezeAuthority}) and can freeze the vault account.`);
  if (state.paused)
    out.push('Transfers are currently PAUSED by the issuer; exercise and expiry cannot settle.');
  else if (state.transferHookProgramId)
    out.push(`A transfer hook (${state.transferHookProgramId}) runs on every transfer.`);
  if (state.transferFee.transferFeeBasisPoints > 0)
    out.push(`${state.transferFee.transferFeeBasisPoints / 100}% transfer fee applies on entry and on payout.`);
  return out;
}
