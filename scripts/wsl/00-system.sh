#!/usr/bin/env bash
# System packages for building Anchor programs. Run as root:
#
#   wsl -d Ubuntu -u root -- bash "/mnt/c/.../scripts/wsl/00-system.sh"
#
# Kept separate from the user-level install so nothing here ever triggers a sudo password
# prompt, which has no stdin when driven from outside WSL and simply hangs.
set -euo pipefail

echo "==> apt update"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

echo "==> Installing build dependencies"
# Each of these fails deep inside a cargo build with an unhelpful error when absent:
#   build-essential  - C toolchain for native crates
#   pkg-config       - crate build scripts locate system libs through it
#   libssl-dev       - openssl-sys
#   libudev-dev      - the Solana CLI's USB/hardware-wallet support
#   libclang-dev     - bindgen, used by several Solana crates
#   protobuf-compiler- protobuf codegen in the validator stack
apt-get install -y -qq \
  build-essential pkg-config libssl-dev libudev-dev \
  llvm libclang-dev clang protobuf-compiler \
  curl git jq unzip

echo "==> Done. Installed:"
for p in gcc pkg-config protoc clang git curl jq; do
  printf '  %-18s %s\n' "$p" "$(command -v "$p" || echo MISSING)"
done
