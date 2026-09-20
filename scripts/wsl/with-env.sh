#!/usr/bin/env bash
# Run a command with the toolchain on PATH *and* .env.local loaded.
#
#   bash scripts/wsl/with-env.sh node scripts/setup-devnet.ts
#   bash scripts/wsl/with-env.sh solana balance
#
# Same reason run.sh exists, plus one more: inline `bash -c '...'` invocations passed from
# Git Bash through wsl.exe get their quoting mangled, so variables silently expand on the
# Windows side and arrive empty. Putting the logic in a file avoids that entirely.
set -uo pipefail

cd "$(dirname "$0")/../.."

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

exec "$@"
