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
# WSL inherits the Windows PATH, so a bare `npx` can resolve to Windows npx.cmd and run
# under cmd.exe, which cannot see the Linux node_modules/.bin symlinks. Put the nvm node
# ahead of it.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
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

# The bracket makes the pattern match the literal name while the pattern TEXT differs from
# it, so this command's own command line is not a match. Plain `pkill -f solana-test-validator`
# matches the shell running it and kills the script. `-x` is not an option either: the exact
# name is 21 characters and pkill caps name matching at 15.
pkill -9 -f '[s]olana-test-validator' 2>/dev/null && sleep 3

# A detached validator from an earlier run can still hold the ports; fail loudly rather
# than letting the validator panic with a confusing bind error.
for port in 8899 8000; do
  if (ss -lntu 2>/dev/null || netstat -lntu 2>/dev/null) | grep -q ":$port "; then
    echo "==> Port $port is still in use. Listening sockets:"
    (ss -lntup 2>/dev/null || netstat -lntup 2>/dev/null) | grep ":$port "
    exit 1
  fi
done

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
