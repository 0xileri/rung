#!/usr/bin/env bash
node -e '
const {Connection,PublicKey}=require("@solana/web3.js");
const {getAssociatedTokenAddressSync,getAccount,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID}=require("@solana/spl-token");
const d=require("./devnet.json");
(async()=>{
  const c=new Connection(process.env.DEVNET_RPC_URL,"confirmed");
  const w=new PublicKey(process.argv[1]);
  const m=d.markets.OPENAI;
  console.log("  SOL        ", (await c.getBalance(w))/1e9);
  for(const [label,mint,prog,dec,mult] of [
    ["mock USDC  ", d.quoteMint, TOKEN_PROGRAM_ID, d.quoteDecimals, 1],
    ["mock OPENAI", m.mint, TOKEN_2022_PROGRAM_ID, m.decimals, m.multiplier]]) {
    try {
      const a=await getAccount(c,getAssociatedTokenAddressSync(new PublicKey(mint),w,false,prog),undefined,prog);
      console.log(`  ${label}`, (Number(a.amount)/10**dec)*mult);
    } catch { console.log(`  ${label}`, "none"); }
  }
})().catch(e=>console.log("  err:",e.message));
' "$1"
