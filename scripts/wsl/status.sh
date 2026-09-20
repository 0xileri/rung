#!/usr/bin/env bash
# Report which parts of the toolchain are present. Safe to run any time.
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

echo "arch    : $(uname -m)"
for c in rustc cargo node npm avm anchor solana cargo-build-sbf; do
  p=$(command -v "$c" 2>/dev/null)
  if [ -n "$p" ]; then
    v=$("$c" --version 2>/dev/null | head -1)
    printf '  %-17s OK    %s\n' "$c" "${v:-$p}"
  else
    printf '  %-17s MISSING\n' "$c"
  fi
done
echo "platform-tools dirs:"
ls -1 "$HOME/.cache/solana" 2>/dev/null | sed 's/^/  /' || echo "  (none)"
