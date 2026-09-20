#!/usr/bin/env bash
# Copy the freshly built IDL into the repo.
#
# The web app imports the IDL, but target/ is gitignored, so a clone would not have it and
# the build fails with "Can't resolve target/idl/rung.json" -- which only shows up in CI,
# never locally. Run this after any `anchor build` that changes the interface.
set -euo pipefail
cd "$(dirname "$0")/.."
cp target/idl/rung.json packages/sdk/idl/rung.json
[ -f target/types/rung.ts ] && cp target/types/rung.ts packages/sdk/idl/rung.ts
echo "synced packages/sdk/idl/rung.json"
