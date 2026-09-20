#!/usr/bin/env bash
node -e '
const {Connection,PublicKey}=require("@solana/web3.js");
const {BorshAccountsCoder}=require("@coral-xyz/anchor");
const idl=require("./packages/sdk/idl/rung.json");
const STATUS=["Open","Matched","Exercised","Expired","Cancelled"];
(async()=>{
  const c=new Connection(process.env.DEVNET_RPC_URL,"confirmed");
  const coder=new BorshAccountsCoder(idl);
  const disc=Buffer.from(idl.accounts.find(a=>a.name==="Position").discriminator);
  const accts=await c.getProgramAccounts(new PublicKey(idl.address),
    {filters:[{memcmp:{offset:0,bytes:disc.toString("base64"),encoding:"base64"}}]});
  console.log("  positions:",accts.length);
  for(const {pubkey,account} of accts){
    const p=coder.decode("Position",account.data);
    const st=Object.keys(p.status)[0];
    console.log("   ",pubkey.toBase58().slice(0,8)+"…",
      "status="+st,
      "target=$"+(Number(p.targetValuationUsd)/1e12).toFixed(2)+"T",
      "strike="+(Number(p.strikeQuoteEscrowed)/1e6),
      "maker="+p.maker.toBase58().slice(0,6),
      "taker="+(p.taker.toBase58()==="11111111111111111111111111111111"?"none":p.taker.toBase58().slice(0,6)));
  }
})().catch(e=>console.log("  err:",e.message));
'
