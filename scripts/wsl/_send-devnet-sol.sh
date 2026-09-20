#!/usr/bin/env bash
# Send devnet SOL to a tester. Devnet SOL is valueless test currency, freely mintable from
# faucets -- this is just faster and more reliable than a rate-limited faucet.
set -uo pipefail
TO="${1:?address}"; AMT="${2:-2}"
echo "from    $(solana address)  ($(solana balance))"
solana transfer "$TO" "$AMT" --allow-unfunded-recipient --commitment confirmed
echo "sender  $(solana balance)"
echo "recip   $(solana balance "$TO")"
