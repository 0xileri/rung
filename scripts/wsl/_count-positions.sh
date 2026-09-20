#!/usr/bin/env bash
node -e '
const {Connection,PublicKey}=require("@solana/web3.js");
const idl=require("./packages/sdk/idl/rung.json");
(async()=>{
  const c=new Connection(process.env.DEVNET_RPC_URL,"confirmed");
  const disc=Buffer.from(idl.accounts.find(a=>a.name==="Position").discriminator);
  const accts=await c.getProgramAccounts(new PublicKey(idl.address),{filters:[{memcmp:{offset:0,bytes:disc.toString("base64"),encoding:"base64"}}]});
  console.log("  Position accounts on devnet:",accts.length);
  const mk=await c.getProgramAccounts(new PublicKey(idl.address));
  console.log("  Total program accounts:",mk.length,"(config + market + positions)");
})().catch(e=>console.log("  error:",e.message));
'
