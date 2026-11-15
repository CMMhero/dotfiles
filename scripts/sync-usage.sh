#!/usr/bin/env bash
# ==============================================================================
# scripts/sync-usage.sh - refresh the vendored copy of the usage CLI.
#
# The tool is written once, in dotfiles-win (usage.mjs, usage-tui.mjs,
# usage-web.mjs + usage-web.html, and the herdr Insights collector it runs as its
# parser). This repo carries a copy under usage/.local/share/usage-cli so a Linux
# box that only has ~/dotfiles still gets `usage`, `usage tui` and `usage web`.
# Copy, don't rewrite: the two repos must never disagree on how a token is
# counted or priced.
#
# Usage:
#   scripts/sync-usage.sh [path-to-dotfiles-win]     # default ~/dotfiles-win
#   scripts/sync-usage.sh --check                    # exit 1 if the copy is stale
# ==============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HERE/usage/.local/share/usage-cli"
CHECK=0
SRC="${WIN_DOTFILES:-$HOME/dotfiles-win}"
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    *) SRC="$arg" ;;
  esac
done

[ -f "$SRC/usage.mjs" ] || { echo "sync-usage: no usage.mjs in $SRC (pass the dotfiles-win path)" >&2; exit 1; }

INSIGHTS=dot_config/herdr-app/mods/insights
FILES=(
  usage.mjs usage-tui.mjs usage-web.mjs usage-web.html
  usage-limits.mjs usage-threads.mjs usage-summary.mjs usage-models.mjs usage-billing.mjs
  dot_config/usage/prices.json
  "$INSIGHTS/collector.mjs"
)
for f in "$SRC/$INSIGHTS"/core/*.mjs; do FILES+=("$INSIGHTS/core/$(basename "$f")"); done
# Fonts and provider icons: everything under usage-web-assets, whatever is there.
while IFS= read -r f; do FILES+=("${f#"$SRC"/}"); done < <(find "$SRC/usage-web-assets" -type f | sort)

stale=0
for rel in "${FILES[@]}"; do
  if ! cmp -s "$SRC/$rel" "$DEST/$rel" 2>/dev/null; then
    stale=1
    if [ "$CHECK" -eq 1 ]; then echo "stale: $rel"; continue; fi
    mkdir -p "$DEST/$(dirname "$rel")"
    cp "$SRC/$rel" "$DEST/$rel"
    echo "updated: $rel"
  fi
done

if [ "$CHECK" -eq 1 ]; then
  [ "$stale" -eq 0 ] && echo "usage copy is current" || exit 1
elif [ "$stale" -eq 0 ]; then
  echo "usage copy already current"
fi
