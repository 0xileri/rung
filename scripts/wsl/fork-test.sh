#!/usr/bin/env bash
# Run Rung against the REAL PreStocks mints on a local mainnet fork.
#
#   bash scripts/wsl/fork-test.sh [SYMBOLS]     (default OPENAI,SPACEX)
#
# Loads the live mint accounts (see scripts/fork-test/prepare.ts for the one byte-level
# change), mainnet's Token-2022 program and feature set, the freshly built program at its
# real address, and warps past epoch 1039 so the mints' live 1% fee slot is the active one.
# Nothing is sent to mainnet; it is only read from.
#
# Build first (scripts/wsl/test-local.sh does) so target/deploy/rung.so is current.
set -uo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

cd "$(dirname "$0")/../.."
LEDGER="$HOME/fork-ledger"
LOG="$HOME/fork-validator.log"
RPC="http://127.0.0.1:8899"
PROGRAM_ID=$(node -e 'console.log(require("./packages/sdk/idl/rung.json").address)')
# Well past 1039 whether or not the local schedule has warmup epochs.
WARP_SLOT=$((1045 * 432000))

[ -f target/deploy/rung.so ] || { echo "target/deploy/rung.so is missing; build first"; exit 1; }

echo "==> Staging mainnet state"
node scripts/fork-test/prepare.ts "${1:-OPENAI,SPACEX}" || exit 1

cleanup() {
  if [ -n "${VALIDATOR_PID:-}" ] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    kill "$VALIDATOR_PID" 2>/dev/null
    wait "$VALIDATOR_PID" 2>/dev/null
  fi
}
trap cleanup EXIT
pkill -9 -f '[s]olana-test-validator' 2>/dev/null && sleep 3

echo "==> Starting fork validator"
rm -rf "$LEDGER"
setsid solana-test-validator --reset --ledger "$LEDGER" \
  --url https://api.mainnet-beta.solana.com --clone-feature-set \
  --clone-upgradeable-program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb \
  --upgradeable-program "$PROGRAM_ID" target/deploy/rung.so none \
  --account-dir "$HOME/rung-fork/accounts" \
  --warp-slot "$WARP_SLOT" >"$LOG" 2>&1 &
VALIDATOR_PID=$!

UP=0
for i in $(seq 1 180); do
  if curl -s --max-time 2 "$RPC" -X POST -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result":"ok"'; then
    echo "==> Fork up after ${i}s"
    UP=1
    break
  fi
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [ "$UP" -ne 1 ]; then
  echo "==> Fork validator did not come up:"
  tail -30 "$LOG"
  tail -30 "$LEDGER/validator.log" 2>/dev/null
  exit 1
fi

echo "==> Running flows"
node scripts/fork-test/run.ts
