#!/usr/bin/env bash
# Report deploy state without exposing the api key.
echo "RPC      ${DEVNET_RPC_URL%%\?*}"
echo "Wallet   $(solana address 2>/dev/null)"
echo "Balance  $(solana balance 2>/dev/null)"
echo "--- program account on devnet ---"
solana program show BEEraLqHNJ8y8yTsXpDZsRAjwB9uKc3Awj1YBLZUKu2r 2>&1 | head -8
echo "--- buffers ---"
solana program show --buffers 2>&1 | head -4
