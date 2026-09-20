#!/usr/bin/env bash
# Toolchain for aarch64 Linux, where the prebuilt binaries do not exist.
#
# This machine is a Snapdragon X Elite, so WSL is aarch64. Anza publishes no
# aarch64-unknown-linux-gnu release of the Solana CLI, so the usual one-line installer
# 404s and everything downstream has to be built from source instead. The SBF compiler
# itself is fine: platform-tools DOES ship a linux-aarch64 build, which cargo-build-sbf
# fetches on first use.
#
#   wsl -d Ubuntu -- bash "/mnt/c/.../scripts/wsl/20-aarch64-toolchain.sh"
#
# Each step is independent and failures are recorded rather than fatal, so one run reports
# everything that is wrong instead of stopping at the first problem. Re-run to resume.
set -uo pipefail

AGAVE_TAG="${AGAVE_TAG:-v4.2.2}"
RESULTS=()

export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
record() { RESULTS+=("$1"); printf '\033[1;%sm  [%s] %s\033[0m\n' "$2" "$3" "$1"; }
ok()   { record "$1" 32 " OK "; }
fail() { record "$1" 31 "FAIL"; }

step() { # step <label> <check-cmd> <install-fn>
  local label="$1" check="$2" fn="$3"
  if have "$check"; then log "$label already present"; ok "$label (already present)"; return; fi
  log "Installing $label"
  if "$fn"; then ok "$label"; else fail "$label"; fi
}

install_node() {
  curl -sSfL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash || return 1
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" || return 1
  nvm install --lts || return 1
}

install_anchor() {
  # avm and anchor are pure Rust, so they build natively on aarch64.
  cargo install --git https://github.com/coral-xyz/anchor avm --force || return 1
  avm install latest || return 1
  avm use latest || return 1
}

install_build_sbf() {
  # The piece that actually compiles the program to a deployable .so. It downloads
  # platform-tools-linux-aarch64 on first use.
  cargo install --git https://github.com/anza-xyz/agave --tag "$AGAVE_TAG" solana-cargo-build-sbf || return 1
}

install_solana_cli() {
  # Needed for keygen, airdrops, deploys and balance checks.
  cargo install --git https://github.com/anza-xyz/agave --tag "$AGAVE_TAG" solana-cli || return 1
}

step "Node (nvm)"        node            install_node
step "Anchor (avm)"      anchor          install_anchor
step "cargo-build-sbf"   cargo-build-sbf install_build_sbf
step "solana CLI"        solana          install_solana_cli

log "Persisting environment"
add_line() { grep -qF -- "$1" "$HOME/.bashrc" 2>/dev/null || echo "$1" >>"$HOME/.bashrc"; }
add_line 'export PATH="$HOME/.cargo/bin:$PATH"'
add_line 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"'
add_line 'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
add_line 'export CARGO_TARGET_DIR="$HOME/.cargo-target"'
mkdir -p "$HOME/.cargo-target"

if have solana && [ ! -f "$HOME/.config/solana/id.json" ]; then
  log "Generating a devnet keypair"
  mkdir -p "$HOME/.config/solana"
  solana-keygen new --no-bip39-passphrase --silent --outfile "$HOME/.config/solana/id.json"
  solana config set --url devnet >/dev/null 2>&1 || true
fi

log "Summary"
for r in "${RESULTS[@]}"; do echo "  $r"; done
