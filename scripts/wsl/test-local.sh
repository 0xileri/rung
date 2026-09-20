#!/usr/bin/env bash
# Run the Anchor suite against a local validator we start ourselves.
#
#   bash scripts/wsl/test-local.sh
#
# Anchor 1.2 spawns `surfpool` for localnet, which has no aarch64 build here. Rather than
# chase another from-source toolchain, we start solana-test-validator ourselves and pass
# --skip-local-validator so anchor just uses the localnet that is already listening.
#
# The ledger lives on native ext4, not under /mnt/c: a validator writes constantly, and the
# Windows filesystem translation layer makes that painfully slow.
set -uo pipefail

export PATH="$HOME/.cargo/bin:$PATH"
LEDGER="$HOME/test-ledger"
LOG="$HOME/test-validator.log"
RPC="http://127.0.0.1:8899"

cleanup() {
  if [ -n "${VALIDATOR_PID:-}" ] && kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "==> Stopping validator (pid $VALIDATOR_PID)"
    kill "$VALIDATOR_PID" 2>/dev/null
    wait "$VALIDATOR_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

pkill -f solana-test-validator 2>/dev/null && sleep 2

echo "==> Starting solana-test-validator"
rm -rf "$LEDGER"
# setsid so the validator survives this script's process group, and no --quiet: genesis
# setup takes a while on first run and the log is the only way to see it progressing.
setsid solana-test-validator --reset --ledger "$LEDGER" >"$LOG" 2>&1 &
VALIDATOR_PID=$!

echo "==> Waiting for RPC (up to 180s; first run builds genesis)"
UP=0
for i in $(seq 1 180); do
  if curl -s --max-time 2 "$RPC" -X POST -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"result":"ok"'; then
    echo "==> Validator up after ${i}s"
    UP=1
    break
  fi
  sleep 1
done

if [ "$UP" -ne 1 ]; then
  echo "==> Validator never became healthy. Startup output:"
  tail -30 "$LOG"
  echo "==> Ledger log:"
  tail -30 "$LEDGER/validator.log" 2>/dev/null
  exit 1
fi

cd "$(dirname "$0")/../.."
echo "==> Running suite"
"$HOME/.avm/bin/anchor-1.2.0" test --skip-local-validator --provider.cluster localnet
STATUS=$?
echo "==> Suite exited $STATUS"
exit $STATUS
