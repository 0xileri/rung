#!/usr/bin/env bash
# Run anchor with a correct environment, bypassing the avm shim.
#
#   bash scripts/wsl/anchor.sh build
#   bash scripts/wsl/anchor.sh deploy --provider.cluster devnet
#
# Why not just `anchor`: ~/.avm/bin/anchor is a shim that, on every invocation, tries to
# install avm's preferred Solana release through the Anza installer. That 404s on aarch64,
# so the shim fails before it ever reaches the real binary. The versioned binary it already
# built works fine, so this calls it directly.
set -euo pipefail

ANCHOR_BIN="${ANCHOR_BIN:-$HOME/.avm/bin/anchor-1.2.0}"
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

if [ ! -x "$ANCHOR_BIN" ]; then
  echo "anchor binary not found at $ANCHOR_BIN" >&2
  echo "available:" >&2
  ls -1 "$HOME/.avm/bin" 2>/dev/null | sed 's/^/  /' >&2
  exit 1
fi

# Deliberately NOT setting CARGO_TARGET_DIR here. Anchor expects to find the built artifact
# at ./target/deploy/<name>.so relative to the workspace, so redirecting the target dir
# elsewhere makes it lose track of its own output.
cd "$(dirname "$0")/../.."
exec "$ANCHOR_BIN" "$@"
