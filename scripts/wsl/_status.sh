#!/usr/bin/env bash
# Report deploy state without exposing the api key.
echo "RPC      ${DEVNET_RPC_URL%%\?*}"
echo "Wallet   $(solana address 2>/dev/null)"
echo "Balance  $(solana balance 2>/dev/null)"
echo "--- program account on devnet ---"
solana program show 6kqka5NWofo1cm6bm5JMhWbQgHeR6YT23qTvwnusSwpM 2>&1 | head -8
echo "--- buffers ---"
solana program show --buffers 2>&1 | head -4
