#!/usr/bin/env bash
# Run any command with the project's toolchain on PATH.
#
#   bash scripts/wsl/run.sh solana balance
#   bash scripts/wsl/run.sh npm install
#
# Exists because a non-interactive `bash -c` does not source ~/.bashrc, so inlining the
# PATH setup into every invocation is both repetitive and easy to get subtly wrong. Routing
# through one script means the environment is defined in exactly one place.
set -euo pipefail

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

# ~/.avm/bin is deliberately NOT on PATH: its `anchor` entry is a shim that fails on this
# platform. Use scripts/wsl/anchor.sh for anchor.

cd "$(dirname "$0")/../.."
exec "$@"
