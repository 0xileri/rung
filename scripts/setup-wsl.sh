#!/usr/bin/env bash
# Provision an Ubuntu/WSL box for building Limit+.
#
# Idempotent: re-running skips anything already present, so it is safe to use to repair a
# partial install. Run from inside WSL, not from Windows.
#
#   bash scripts/setup-wsl.sh
set -euo pipefail

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

log "System packages"
# Anchor's proc-macro and BPF builds need a C toolchain, OpenSSL headers and libclang; the
# Solana CLI additionally wants libudev. Missing any of these fails deep inside a cargo
# build with an opaque error, so install them up front.
sudo apt-get update -qq
sudo apt-get install -y -qq \
  build-essential pkg-config libssl-dev libudev-dev \
  llvm libclang-dev protobuf-compiler curl git jq

if have rustc; then
  log "Rust already installed: $(rustc --version)"
else
  log "Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
fi
export PATH="$HOME/.cargo/bin:$PATH"

if have solana; then
  log "Solana CLI already installed: $(solana --version)"
else
  log "Solana CLI (Anza)"
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
fi
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

if have node; then
  log "Node already installed: $(node --version)"
else
  log "Node via nvm (needed to run the Anchor test suite)"
  curl -sSfL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
fi

if have anchor; then
  log "Anchor already installed: $(anchor --version)"
else
  log "Anchor via avm"
  cargo install --git https://github.com/coral-xyz/anchor avm --force
  avm install latest
  avm use latest
fi

log "Persisting PATH in ~/.bashrc"
add_path() {
  grep -qF "$1" "$HOME/.bashrc" 2>/dev/null || echo "$1" >>"$HOME/.bashrc"
}
add_path 'export PATH="$HOME/.cargo/bin:$PATH"'
add_path 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"'
add_path 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'

if [ ! -f "$HOME/.config/solana/id.json" ]; then
  log "Generating a devnet keypair"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$HOME/.config/solana/id.json"
fi
solana config set --url devnet >/dev/null

log "Versions"
printf '  rustc   %s\n' "$(rustc --version 2>/dev/null || echo MISSING)"
printf '  solana  %s\n' "$(solana --version 2>/dev/null || echo MISSING)"
printf '  anchor  %s\n' "$(anchor --version 2>/dev/null || echo MISSING)"
printf '  node    %s\n' "$(node --version 2>/dev/null || echo MISSING)"
printf '  wallet  %s\n' "$(solana address 2>/dev/null || echo MISSING)"

log "Done. Open a new shell (or: source ~/.bashrc) so the PATH changes take effect."
