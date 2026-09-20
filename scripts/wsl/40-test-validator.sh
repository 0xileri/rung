#!/usr/bin/env bash
# Build a local test validator from source.
#
# Initially skipped as too heavy, then reconsidered: the public devnet RPC rate-limits hard
# enough to make a single program deploy fail and retry, and the test suite issues far more
# transactions than a deploy does. Fighting a throttle on every test run costs more than
# this build does once.
#
# The crate name has moved around across versions, so try the plausible ones in order.
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

AGAVE_TAG="${AGAVE_TAG:-v4.2.2}"

if command -v solana-test-validator >/dev/null 2>&1; then
  echo "solana-test-validator already present: $(solana-test-validator --version 2>&1 | head -1)"
  exit 0
fi

# The binary is not its own crate. `solana-test-validator` is a LIBRARY crate, and
# `agave-test-validator` does not exist; the binary is built by the `agave-validator`
# package from validator/src/bin/solana-test-validator.rs, so it needs an explicit --bin.
# Without --bin, cargo would also build the full agave-validator, which is far heavier.
echo "==> Building solana-test-validator from the agave-validator package"
cargo install --git https://github.com/anza-xyz/agave --tag "$AGAVE_TAG" \
  agave-validator --bin solana-test-validator

echo "==> Result"
for b in solana-test-validator agave-test-validator; do
  printf '  %-26s %s\n' "$b" "$(command -v "$b" || echo MISSING)"
done
