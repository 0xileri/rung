#!/usr/bin/env bash
# Deploy or upgrade the Rung program on any cluster.
#
#   bash scripts/wsl/deploy-program.sh <RPC_URL>
#
# Examples:
#   bash scripts/wsl/deploy-program.sh https://api.devnet.solana.com
#   bash scripts/wsl/deploy-program.sh "$MAINNET_RPC_URL"
#
# Only the RPC host is ever printed: paid endpoints carry their API key in the query string.
#
# Safe to re-run after a failure. The upload goes into a buffer whose keypair is kept at
# target/deploy/rung-buffer-<host>.json, so a second attempt writes into the SAME buffer
# rather than locking another ~1.75 SOL of rent in a fresh one. The file is deleted once the
# deploy lands, because the CLI closes the buffer then.
#
# Always --use-rpc: the default path sends writes to the leader's TPU over QUIC, which fails
# from a residential connection or WSL's NAT as "Max retries exceeded".
set -uo pipefail
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

RPC="${1:?usage: deploy-program.sh <RPC_URL>}"
HOST="${RPC%%\?*}"
cd "$(dirname "$0")/../.."

SO=target/deploy/rung.so
PROGRAM_KEYPAIR=target/deploy/rung-keypair.json
[ -f "$SO" ] || { echo "Missing $SO -- build first (scripts/wsl/test-local.sh builds and tests)."; exit 1; }
[ -f "$PROGRAM_KEYPAIR" ] || { echo "Missing $PROGRAM_KEYPAIR -- this is the program's identity; restore it from backup."; exit 1; }

PROGRAM_ID=$(solana address -k "$PROGRAM_KEYPAIR")
SO_LEN=$(stat -c %s "$SO")
BUFFER_KEYPAIR="target/deploy/rung-buffer-$(echo "$HOST" | sed 's#https\?://##; s#[^A-Za-z0-9.-]#_#g').json"

echo "==> RPC      $HOST"
echo "==> Program  $PROGRAM_ID"
echo "==> Payer    $(solana address)  ($(solana balance --url "$RPC"))"
echo "==> Binary   $SO_LEN bytes, sha256 $(sha256sum "$SO" | cut -c1-16)"

# An existing program's data account is sized at deploy time. A larger binary needs it
# extended first, or the upgrade fails after the whole buffer has been uploaded.
if solana program show "$PROGRAM_ID" --url "$RPC" >/tmp/rung-show.txt 2>/dev/null; then
  CURRENT=$(awk '/Data Length:/ {print $3}' /tmp/rung-show.txt)
  echo "==> Existing program, data length $CURRENT"
  if [ "$SO_LEN" -gt "$CURRENT" ]; then
    GROW=$((SO_LEN - CURRENT))
    # The loader refuses an extension smaller than 10 KiB; the surplus is headroom for the
    # next upgrade, at roughly 0.07 SOL of rent.
    [ "$GROW" -lt 10240 ] && GROW=10240
    echo "==> Extending program data by $GROW bytes"
    solana program extend "$PROGRAM_ID" "$GROW" --url "$RPC" || exit 1
  fi
else
  echo "==> No program at this address yet: fresh deploy"
fi

# No solana-keygen in the aarch64 from-source install; gen-keypair.mjs does the same job.
[ -f "$BUFFER_KEYPAIR" ] || node scripts/wsl/gen-keypair.mjs "$BUFFER_KEYPAIR" >/dev/null || exit 1
echo "==> Buffer   $(solana address -k "$BUFFER_KEYPAIR")"

solana program deploy "$SO" \
  --program-id "$PROGRAM_KEYPAIR" \
  --buffer "$BUFFER_KEYPAIR" \
  --url "$RPC" \
  --use-rpc \
  --with-compute-unit-price 50000 \
  --max-sign-attempts 100
STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  rm -f "$BUFFER_KEYPAIR"
  echo "==> Deployed. $(solana program show "$PROGRAM_ID" --url "$RPC" | grep -E 'Data Length|Authority|Last Deployed')"
else
  echo "==> Deploy failed (exit $STATUS). Re-run the same command to resume into the same buffer."
  echo "    To abandon it and reclaim its rent: solana program close $(solana address -k "$BUFFER_KEYPAIR") --url <RPC>"
fi
exit "$STATUS"
