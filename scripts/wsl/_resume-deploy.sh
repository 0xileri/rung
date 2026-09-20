#!/usr/bin/env bash
# Resume a partially-uploaded buffer instead of starting over: each fresh attempt locks
# another ~1.75 SOL of rent in a new buffer.
#
# --use-rpc is the important flag. By default `solana program deploy` sends its hundreds of
# write transactions straight to the leader's TPU over QUIC, which is unreliable from a
# residential connection and worse from inside WSL's NAT -- it surfaces as the unhelpful
# "Max retries exceeded". Routing through the configured RPC provider instead lets Helius
# handle landing them.
#
# The priority fee covers the other half: during devnet congestion, zero-fee transactions
# are simply dropped.
set -uo pipefail
BUFFER="${1:?usage: _resume-deploy.sh <buffer-address>}"
echo "==> Resuming into buffer $BUFFER (via RPC, with priority fee)"
exec solana program deploy \
  --buffer "$BUFFER" \
  --program-id target/deploy/rung-keypair.json \
  --use-rpc \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 100 \
  target/deploy/rung.so
