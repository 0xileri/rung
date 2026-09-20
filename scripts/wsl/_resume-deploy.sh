#!/usr/bin/env bash
# Resume the partially-uploaded buffer instead of starting over. Each fresh attempt creates
# a new buffer and locks ~1.75 SOL of rent in it, so restarting blind is expensive.
set -uo pipefail
BUFFER="${1:?usage: _resume-deploy.sh <buffer-address>}"
echo "==> Resuming into buffer $BUFFER"
exec solana program deploy \
  --buffer "$BUFFER" \
  --program-id target/deploy/rung-keypair.json \
  target/deploy/rung.so
