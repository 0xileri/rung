#!/usr/bin/env bash
# Everything the local stack needs to be usable, then stay attached.
#
#   bash scripts/wsl/local-stack-up.sh [tester-address]
#
# local-stack.sh starts a fresh validator with fresh mints, so the floors, the protocol
# parameters and any tester's balances all have to be recreated each time. This does all of
# it, then tails the validator log in the foreground: WSL shuts its VM down once no session
# is attached, taking a setsid'd validator with it, so something has to stay attached.
set -uo pipefail

REPO="/mnt/c/Users/HP/stocklana build"
RPC="http://127.0.0.1:8899"
cd "$REPO"

bash scripts/wsl/local-stack.sh || exit 1

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

echo "==> Seeding floors"
SEED_RPC_URL="$RPC" DEPLOYMENT_FILE=local.json node scripts/seed-demo-commitments.ts 2>&1 | grep -E '^(Create|Seeded|  \$)' || exit 1

echo "==> Protocol parameters: 1% fee, 10 USDC minimum fill"
DEVNET_RPC_URL="$RPC" DEPLOYMENT_FILE=local.json node scripts/set-protocol-params.ts --fee-bps 100 --min-fill 10 2>&1 | grep -E '^(Fee|Min fill)' || exit 1

if [ -n "${1:-}" ]; then
  echo "==> Funding tester $1"
  FUND_RPC_URL="$RPC" DEPLOYMENT_FILE=local.json node scripts/fund-tester.ts "$1" 2>&1 | grep -E 'mock (USDC|OPENAI)' || exit 1
fi

echo "==> READY"
exec tail -f "$HOME/local-stack.log"
