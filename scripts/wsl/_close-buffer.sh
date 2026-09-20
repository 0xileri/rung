#!/usr/bin/env bash
# Recover rent from an abandoned deploy buffer. Closing returns its lamports to the
# authority; the buffer holds a partial upload that is no longer needed.
set -uo pipefail
echo "before: $(solana balance)"
solana program close "${1:?buffer address}" --bypass-warning
echo "after:  $(solana balance)"
