#!/usr/bin/env bash
# sync-skills.sh - clone (or pull) my skills repo and link every skill in it
# into ~/.agents/skills. Safe to run any time.
set -euo pipefail

REPO_URL="https://github.com/CMMhero/skills.git"
REPO_DIR="$HOME/skills"
TARGET="$HOME/.agents/skills"

mkdir -p "$TARGET"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" pull --rebase --autostash
else
  git clone "$REPO_URL" "$REPO_DIR"
fi

for skill in "$REPO_DIR"/*/; do
  [ -f "$skill/SKILL.md" ] || continue
  name="$(basename "$skill")"
  link="$TARGET/$name"
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    echo "  [warn] $link is a real dir, left alone"; continue
  fi
  ln -sfn "$skill" "$link"
done

for link in "$TARGET"/*; do
  [ -L "$link" ] || continue
  tgt="$(readlink "$link")"
  case "$tgt" in "$REPO_DIR"*) [ -e "$tgt" ] || { rm -f "$link"; echo "  removed stale $link"; } ;; esac
done

n=$(find "$REPO_DIR" -maxdepth 2 -name SKILL.md | wc -l)
echo "  [ok] $n skills linked into $TARGET"
