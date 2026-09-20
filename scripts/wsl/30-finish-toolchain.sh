#!/usr/bin/env bash
# Fills the two gaps left by 20-aarch64-toolchain.sh.
#
#   1. cargo-build-sbf was split out of the agave repo into its own crate
#      (anza-xyz/cargo-build-sbf, published on crates.io), so installing it from an agave
#      tag fails with "could not find solana-cargo-build-sbf".
#   2. avm installs its shims into ~/.avm/bin, which is not ~/.cargo/bin and was missing
#      from PATH, so `anchor` resolved to nothing.
set -uo pipefail

export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if command -v cargo-build-sbf >/dev/null 2>&1; then
  log "cargo-build-sbf present: $(cargo-build-sbf --version 2>&1 | head -1)"
else
  log "Installing cargo-build-sbf from crates.io"
  cargo install cargo-build-sbf || echo "FAILED: cargo-build-sbf"
fi

log "Selecting an Anchor version"
avm install latest 2>&1 | tail -2 || echo "FAILED: avm install"
avm use latest 2>&1 | tail -2 || echo "FAILED: avm use"

log "Persisting ~/.avm/bin on PATH"
grep -qF '.avm/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/.avm/bin:$PATH"' >>"$HOME/.bashrc"

log "Versions"
for c in rustc cargo node anchor avm solana cargo-build-sbf; do
  if command -v "$c" >/dev/null 2>&1; then
    printf '  %-17s %s\n' "$c" "$("$c" --version 2>&1 | head -1)"
  else
    printf '  %-17s MISSING\n' "$c"
  fi
done
