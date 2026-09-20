#!/usr/bin/env bash
# Next dev server, run inside WSL so it uses the Linux-native swc binaries the install
# fetched. WSL2 forwards localhost, so the app is reachable from Windows at :3000.
set -uo pipefail
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
cd "/mnt/c/Users/HP/stocklana build"
exec node node_modules/next/dist/bin/next dev apps/web -p 3000
