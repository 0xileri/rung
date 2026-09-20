#!/usr/bin/env bash
# Deploy to devnet through a custom RPC.
#
#   bash scripts/wsl/deploy-devnet.sh
#
# Reads DEVNET_RPC_URL from .env.local. The public devnet endpoint rate-limits hard enough
# that a 354KB program upload fails partway through -- a paid endpoint's free tier is what
# makes this reliable.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [ -f .env.local ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env.local; set +a
fi

RPC="${DEVNET_RPC_URL:-}"
if [ -z "$RPC" ]; then
  echo "DEVNET_RPC_URL is not set. Copy .env.example to .env.local and add your RPC URL." >&2
  exit 1
fi

# Print only the host, never the key.
echo "==> Deploying via ${RPC%%\?*}"
solana config set --url "$RPC" >/dev/null
echo "==> Wallet  $(solana address)"
echo "==> Balance $(solana balance)"

# A previous run may have left a partially uploaded buffer; anchor resumes from it.
exec "$HOME/.avm/bin/anchor-1.2.0" deploy --provider.cluster "$RPC"
