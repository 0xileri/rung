#!/usr/bin/env bash
# Rust, Solana CLI, Node and Anchor, installed into the normal user's home.
#
#   wsl -d Ubuntu -- bash "/mnt/c/.../scripts/wsl/10-user.sh"
#
# Nothing here needs root, so nothing here can stall on a sudo password prompt. Run
# 00-system.sh first. Idempotent: re-running skips whatever is already present, so this is
# also the way to repair a partial install.
set -euo pipefail

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

if have rustc; then log "Rust present: $(rustc --version)"; else
  log "Installing Rust"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  export PATH="$HOME/.cargo/bin:$PATH"
fi

if have solana; then log "Solana CLI present: $(solana --version)"; else
  log "Installing Solana CLI (Anza)"
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
  export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
fi

if have node; then log "Node present: $(node --version)"; else
  log "Installing Node via nvm"
  curl -sSfL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
fi

if have anchor; then log "Anchor present: $(anchor --version)"; else
  log "Installing Anchor via avm (slow: builds from source)"
  cargo install --git https://github.com/coral-xyz/anchor avm --force
  avm install latest
  avm use latest
fi

log "Persisting environment in ~/.bashrc"
add_line() { grep -qF -- "$1" "$HOME/.bashrc" 2>/dev/null || echo "$1" >>"$HOME/.bashrc"; }
add_line 'export PATH="$HOME/.cargo/bin:$PATH"'
add_line 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"'
add_line 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
# The repo lives on the Windows filesystem, which WSL reaches over a translation layer that
# is slow for many small file operations. Cargo's target/ tree is exactly that pattern, so
# keep build artifacts on native ext4 while leaving the source where it is.
add_line 'export CARGO_TARGET_DIR="$HOME/.cargo-target"'

mkdir -p "$HOME/.cargo-target"

if [ ! -f "$HOME/.config/solana/id.json" ]; then
  log "Generating a devnet keypair"
  mkdir -p "$HOME/.config/solana"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$HOME/.config/solana/id.json"
fi
solana config set --url devnet >/dev/null 2>&1 || true

log "Versions"
printf '  rustc   %s\n' "$(rustc --version 2>/dev/null || echo MISSING)"
printf '  cargo   %s\n' "$(cargo --version 2>/dev/null || echo MISSING)"
printf '  solana  %s\n' "$(solana --version 2>/dev/null || echo MISSING)"
printf '  anchor  %s\n' "$(anchor --version 2>/dev/null || echo MISSING)"
printf '  node    %s\n' "$(node --version 2>/dev/null || echo MISSING)"
printf '  wallet  %s\n' "$(solana address 2>/dev/null || echo MISSING)"
