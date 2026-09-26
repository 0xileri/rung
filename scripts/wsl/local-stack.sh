#!/usr/bin/env bash
# Stand up the whole thing locally: validator, program, mock market, seeded floors.
#
#   bash scripts/wsl/local-stack.sh          # start and seed
#   bash scripts/wsl/local-stack.sh --stop   # tear down
#
# Devnet is the shared demo environment and cannot be upgraded mid-competition without
# breaking whatever is pointed at it. This is the same stack on a local validator, so a
# change to the program can be exercised end to end — including from the web app — before it
# goes anywhere public.
#
# The ledger lives on native ext4, not under /mnt/c: a validator writes constantly, and the
# Windows filesystem translation layer makes that painfully slow.
set -uo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

REPO="/mnt/c/Users/HP/stocklana build"
LEDGER="$HOME/local-stack-ledger"
LOG="$HOME/local-stack.log"
RPC="http://127.0.0.1:8899"
KEY="$HOME/.config/solana/id.json"

if [ "${1:-}" = "--stop" ]; then
  pkill -9 -f '[s]olana-test-validator' 2>/dev/null && echo "==> Validator stopped" || echo "==> Nothing running"
  # The addresses a local run wrote belong to a ledger that no longer exists.
  (cd "$REPO" && git checkout -- local.json 2>/dev/null) && echo "==> local.json restored"
  exit 0
fi

pkill -9 -f '[s]olana-test-validator' 2>/dev/null && sleep 3

echo "==> Starting solana-test-validator"
rm -rf "$LEDGER"
setsid solana-test-validator --reset --ledger "$LEDGER" >"$LOG" 2>&1 &

echo "==> Waiting for RPC"
for i in $(seq 1 180); do
  if curl -s --max-time 2 "$RPC" -X POST -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result":"ok"'; then
    echo "==> Validator up after ${i}s"
    break
  fi
  sleep 1
done

cd "$REPO"
solana config set --url "$RPC" >/dev/null
solana airdrop 100 "$(solana address -k "$KEY")" --url "$RPC" >/dev/null 2>&1

echo "==> Deploying the program"
solana program deploy target/deploy/rung.so \
  --program-id target/deploy/rung-keypair.json \
  --url "$RPC" --keypair "$KEY" || exit 1

echo "==> Seeding the market and floors"
# setup-devnet.ts reads the cluster from DEVNET_RPC_URL and writes its addresses to
# devnet.json; pointing both at localhost keeps one code path for both environments.
DEVNET_RPC_URL="$RPC" DEPLOYMENT_FILE="local.json" node scripts/setup-devnet.ts || exit 1

echo
echo "==> Local stack ready on $RPC"
echo "    Web:  NEXT_PUBLIC_CLUSTER=localnet bash scripts/wsl/dev.sh"
echo "    Stop: bash scripts/wsl/local-stack.sh --stop"
