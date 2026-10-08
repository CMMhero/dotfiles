#!/usr/bin/env python3
"""Swap tv's default CLI tools for the ones this dotfiles setup prefers.

television's channel files are fetched from upstream by `tv update-channels` and
land in ~/.config/television/cable/. They are machine state, not tracked config,
so the substitutions live here and are re-applied on every install rather than
being committed as channel files. Two reasons for that over stowing them:

  - `tv update-channels` skips any channel that already exists on disk. A
    committed channel file would therefore be frozen forever: upstream fixes and
    new keys would never arrive, with nothing in the output to say so.
  - upstream moves (television 0.15.x pinned its channels to a version tag), and
    a tracked copy silently keeps serving commands from the version it was
    written against.

This runs AFTER `tv update-channels`, so it always patches the current upstream
file. Every substitution is an exact literal match; if one is missing, the patch
is reported as unapplied rather than passing silently. That matters: upstream
rewording a command must be visible here, not show up later as a channel that
quietly reverted to `ls`.

The replacement values are written as plain strings and escaped by json.dumps,
which is TOML basic-string compatible. Writing them pre-escaped by hand is how
the mounts.toml source line went wrong once -- nested quotes inside a TOML
string inside a shell command inside a patch table.

Idempotent: a value already present is left alone and not counted as a change.
"""

import json
import os
import sys
from pathlib import Path

try:
    from tomllib import load as toml_load
except ModuleNotFoundError:  # Python < 3.11 (e.g. Ubuntu 22.04's 3.10)
    sys.stderr.write(
        "patch-tv-channels: needs Python 3.11+ for tomllib; this is "
        f"{sys.version.split()[0]}.\n"
        "  tv channels are left on upstream's ls/df/cat. To fix:\n"
        "    apt install python3.11   # or newer, then re-run install.sh\n"
    )
    sys.exit(2)

CABLE = Path(os.environ.get("TV_CABLE_DIR", Path.home() / ".config/television/cable"))

# section, key, expected-current, replacement.
# `expected-current` is what upstream ships today; it doubles as the guard that
# tells us upstream changed underneath us.
PATCHES = {
    "dirs.toml": [
        # `ls -la --color=always` -> eza, same flags. eza is a drop-in for the
        # long listing and adds icons/git status.
        ("preview", "command", "ls -la --color=always '{}'", "eza -la --color=always '{}'"),
        ("metadata", "requirements", ["fd"], ["fd", "eza"]),
    ],
    "zoxide.toml": [
        ("preview", "command", "ls -la --color=always '{}'", "eza -la --color=always '{}'"),
        ("metadata", "requirements", ["zoxide"], ["zoxide", "eza"]),
    ],
    "mounts.toml": [
        # duf has no `--output` machine format: `-output` still draws the box
        # table, so it cannot be split into columns by tv's {split: :N}. Its
        # `-json` can, and jq turns that into the same space-separated columns
        # the old `df --output=...` produced, which is what `display` parses.
        #
        # The .total > 0 guards are not defensive padding: this machine has a
        # mount with total 0, and `jq` fails the whole pipeline on
        # "number (0) and number (0) cannot be divided because the divisor is
        # zero" -- an error, not a null. Unpatched, that empties the channel.
        (
            "source",
            "command",
            "df -h --output=target,fstype,size,used,avail,pcent 2>/dev/null | tail -n +2",
            "duf -json 2>/dev/null | jq -r '.[] | "
            "[.mount_point, .fs_type, "
            "(if .total > 0 then ((.total/1048576*10|round)/10|tostring) else \"0\" end), "
            "(if .total > 0 then ((.used/1048576*10|round)/10|tostring) else \"0\" end), "
            "(if .total > 0 then ((.free/1048576*10|round)/10|tostring) else \"0\" end), "
            "(if .total > 0 then ((.used/.total*100|round)|tostring) else \"0\" end)] "
            '| join(" ")\'',
        ),
        ("source", "display", "{split: :0}", "{split: :0}  {split: :1}  {split: :5}% used, {split: :4}M free"),
        # `df -h <path>` has no duf equivalent: `duf --only` wants a device group,
        # not a path, and rejects a mount point with "unknown device group: /".
        # So the selected mount's numbers come from the same -json as the source,
        # filtered by mount point, and eza lists the directory below it.
        (
            "preview",
            "command",
            "df -h '{}' && echo && ls -la '{}' 2>/dev/null | head -20",
            "duf -json 2>/dev/null | jq -r --arg m '{}' '.[] | select(.mount_point==$m) | "
            '"\\(.mount_point)  \\(.fs_type)  '
            'used=\\((.used/1048576*10|round)/10)MiB of \\((.total/1048576*10|round)/10)MiB '
            '(\\((if .total>0 then (.used/.total*100|round) else 0 end))%)  '
            'avail=\\((.free/1048576*10|round)/10)MiB"\'; echo; '
            "eza -la --color=always '{}' 2>/dev/null | head -20",
        ),
        ("metadata", "requirements", ["df", "awk"], ["duf", "jq", "eza"]),
    ],
    "node-packages.toml": [
        # `ls -d node_modules/*/ | sed | grep` produced bare package names, which
        # is what `output = "{}"` substitutes into the preview path. eza -1 with
        # --only-dirs gives the same bare names, one per line.
        (
            "source",
            "command",
            "ls -d node_modules/*/ 2>/dev/null | sed 's|node_modules/||;s|/$||' | grep -v '^\\.'",
            "eza -1 --only-dirs node_modules 2>/dev/null",
        ),
        # --color=never is load-bearing, not a preference: this output is piped
        # into jq, and bat's ANSI codes make it fail to parse with
        # "jq: parse error: Invalid numeric literal at line 1, column 2".
        ("preview", "command", "cat 'node_modules/{}/package.json' 2>/dev/null | jq -C '{name, version, description, license, homepage, main}'",
         "bat --color=never --style=plain 'node_modules/{}/package.json' 2>/dev/null | jq -C '{name, version, description, license, homepage, main}'"),
        # The one place glow earns its place: this is a README, and `cat | less`
        # showed raw markdown. -p first so the page renders in the action's paged
        # output; the bare glow fallback is the TUI if -p is unavailable.
        ("actions.readme", "command", "cat node_modules/{}/README.md 2>/dev/null | less",
         "glow -p 'node_modules/{}/README.md' 2>/dev/null || glow 'node_modules/{}/README.md'"),
        ("metadata", "requirements", ["node"], ["node", "eza", "bat", "jq", "glow"]),
    ],
    "python-venvs.toml": [
        # Display-only, so unlike node-packages this one keeps its colour.
        ("preview", "command", "cat '{}/pyvenv.cfg' 2>/dev/null && echo '' && echo 'Packages:' && '{}/bin/pip' list --format=columns 2>/dev/null | head -20",
         "bat --color=always --style=plain '{}/pyvenv.cfg' 2>/dev/null && echo '' && echo 'Packages:' && '{}/bin/pip' list --format=columns 2>/dev/null | head -20"),
        ("metadata", "requirements", ["find"], ["find", "bat"]),
    ],
}


def patch_file(path, patches):
    """Apply patches to one channel file. Returns (changed, unapplied)."""
    text = path.read_text()
    changed, unapplied = [], []

    # Compare against the PARSED value, never the raw line. TOML's basic strings
    # escape backslashes, so upstream's `grep -v '^\\.'` is stored as four
    # characters in the file but parses to `grep -v '^\.'`. Matching the raw
    # text against a logical expected string silently never matches anything
    # containing a backslash, which is exactly how the node-packages source
    # substitution was reported as "upstream text changed" when upstream had not
    # changed at all.
    try:
        with path.open("rb") as fh:
            doc = toml_load(fh)
    except Exception as exc:  # noqa: BLE001 - surfaced as an unapplied patch
        return [], [f"(unparseable TOML: {exc})"]

    for section, key, expected, replacement in patches:
        # `actions.readme.command` is one level deeper than the rest: TOML nests
        # [actions.readme] as doc["actions"]["readme"]["command"], so a plain
        # doc.get("actions.readme") is empty. Split a dotted section name and
        # walk it. Same code path then also yields the real [actions.readme]
        # header text for locating the raw line below.
        parts = section.split(".")
        node = doc
        for part in parts:
            node = node.get(part, {}) if isinstance(node, dict) else {}
        current = node.get(key) if isinstance(node, dict) else None

        if current == replacement:
            continue  # already patched; idempotent
        if current != expected:
            unapplied.append(
                f"{section}.{key} (upstream value is {current!r}, not {expected!r})"
            )
            continue

        # Locate the raw assignment line to rewrite. The section body ends at
        # the next [header] at column 0, so a `command =` in a later section
        # cannot be matched by mistake. For a dotted section the header is the
        # full name, so [actions.readme] not [actions].
        start = f"[{section}]"
        sec_at = text.find(start)
        if sec_at < 0:
            unapplied.append(f"{section}.{key} (no [{section}] section)")
            continue
        rest = text[sec_at + len(start):]
        nxt = rest.find("\n[")
        end = sec_at + len(start) + (nxt if nxt >= 0 else len(rest))
        body = text[sec_at + len(start):end]

        line_at = None
        for line in body.splitlines(keepends=True):
            stripped = line.lstrip()
            if stripped.startswith(f"{key} = ") or stripped.startswith(f"{key}="):
                line_at = line
                break
        if line_at is None:
            unapplied.append(f"{section}.{key} (key not found in [{section}])")
            continue

        # json.dumps is TOML basic-string compatible, and it escapes the nested
        # quotes in the mounts.toml jq program correctly. Hand-escaping those
        # is what produces a jq syntax error at run time.
        # json.dumps handles both cases: a string becomes a quoted TOML basic
        # string, and a list of requirements becomes a TOML array. Escaping the
        # nested quotes in the mounts.toml jq program by hand is what produces a
        # jq syntax error at run time.
        new_line = f"{key} = {json.dumps(replacement)}\n"
        text = text[:sec_at + len(start)] + body.replace(line_at, new_line, 1) + text[end:]
        changed.append(f"{section}.{key}")

    if changed:
        path.write_text(text)
    return changed, unapplied


def main():
    if not CABLE.is_dir():
        print(f"patch-tv-channels: {CABLE} does not exist; nothing to patch", file=sys.stderr)
        return 0

    total_changed, all_unapplied = 0, []
    for name, patches in PATCHES.items():
        path = CABLE / name
        if not path.is_file():
            all_unapplied.append(f"{name} (missing; run `tv update-channels`)")
            continue
        changed, unapplied = patch_file(path, patches)
        total_changed += len(changed)
        all_unapplied.extend(f"{name}: {u}" for u in unapplied)
        if changed:
            print(f"patched {name}: {', '.join(changed)}")

    if all_unapplied:
        # Loud, and non-zero. A silent miss here means a channel quietly kept
        # upstream's ls/df/cat, which is exactly the failure this script exists
        # to make visible -- so install.sh must see it as a failure, not a pass.
        print(f"patch-tv-channels: {len(all_unapplied)} substitution(s) did not apply:", file=sys.stderr)
        for u in all_unapplied:
            print(f"  - {u}", file=sys.stderr)
        print(f"patch-tv-channels: {total_changed} substitution(s) applied")
        return 1

    print(f"patch-tv-channels: {total_changed} substitution(s) applied")
    return 0


if __name__ == "__main__":
    sys.exit(main())