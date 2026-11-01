#!/usr/bin/env bash
# ==============================================================================
# scripts/sync-skills.sh - one store for every agent skill, linked into every
# harness. The WSL counterpart of dotfiles-win/sync-skills.ps1.
#
# Usage:
#   ./sync-skills.sh                 # pull, adopt, link, prune
#   ./sync-skills.sh --status        # report only, change nothing
#   ./sync-skills.sh --dry-run       # print every action
#   ./sync-skills.sh --push          # commit + push adopted skills
#   ./sync-skills.sh --no-pull       # skip `git pull`
#   ./sync-skills.sh --pull-only     # git pull, nothing else
#   ./sync-skills.sh --after-install # --no-pull --push, quiet unless it moved
#
# Run by install.sh, by `upd skills`, and by the `skills` function in fish's
# config after `skills add|remove|update`, so an install is never a manual
# follow-up.
#
# The store is ~/skills (CMMhero/skills), the same repo the Windows machine
# uses:
#
#   ~/skills/<name>/            hand-written skills, one dir per skill
#   ~/skills/external/<name>/   everything the `skills` CLI installed
#
# and every agent directory is symlinked into it. One edit or one `git pull`
# reaches every harness, and both machines share files through git instead of
# through separate re-downloads.
#
# ADOPTION is the other half. A directory arrives in a harness dir by
# `skills add`, by an older skills version, or by hand. On the next run it is
# moved into the store and linked back. A same-named skill that DIFFERS is
# never overwritten -- it is reported and left alone, because guessing which
# copy is the good one is how work gets lost.
# ==============================================================================

set -uo pipefail

REPO="git@github.com:CMMhero/skills.git"
STORE="$HOME/skills"
EXTERNAL="$STORE/external"

# Directories the `skills` CLI uses per harness. .agents/skills and
# .claude/skills are always created; the rest only when that harness is
# already on the machine, so this does not scatter empty dotdirs.
TARGETS=()
ALWAYS_TARGETS=(".agents/skills" ".claude/skills")
CANDIDATE_TARGETS=(
    ".config/opencode/skills"
    ".pi/agent/skills"
    ".codex/skills"
)

STATUS=0; DRY=0; NO_PULL=0; PUSH=0; PULL_ONLY=0; QUIET=0

for arg in "$@"; do
    case "$arg" in
        --status)        STATUS=1; DRY=1 ;;
        --dry-run|-n)    DRY=1 ;;
        --no-pull)       NO_PULL=1 ;;
        --push)          PUSH=1 ;;
        --pull-only)     PULL_ONLY=1 ;;
        --after-install) NO_PULL=1; PUSH=1; QUIET=1 ;;
        -h|--help)       sed -n '2,42p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

RULE='==============================================================='
ADOPTED=()
LINKED=0
PRUNED=()
CONFLICTS=()
FAILURES=()

step() { [ "$QUIET" = 1 ] && return 0; printf '\n%s\n  %s\n%s\n' "$RULE" "$1" "$RULE"; }
info()  { [ "$QUIET" = 1 ] && return 0; printf '   -> %s\n' "$1"; }
ok()    { [ "$QUIET" = 1 ] && return 0; printf '   [ok] %s\n' "$1"; }
note()  { printf '   [ok] %s\n' "$1"; }
skip()  { [ "$QUIET" = 1 ] && return 0; printf '   [--] %s\n' "$1"; }
warn()  { printf '   [!!] %s\n' "$1" >&2; }
plan()  { printf '   [dry] %s\n' "$1"; }

# A skill is a directory with a SKILL.md. Anything else in a store or harness
# dir (the repo README, codex's own .system dir, a stray folder) is not a skill
# and is never linked, adopted or pruned.
is_skill() { [ -d "$1" ] && [ -f "$1/SKILL.md" ]; }

# Content fingerprint: relative path + sha256 per file, sorted, hashed once
# more. Timestamps are useless here -- git checkouts and copies rewrite them.
dir_hash() {
    (
        cd "$1" 2>/dev/null || exit 1
        find . -type f -print0 | LC_ALL=C sort -z |
            while IFS= read -r -d '' f; do
                printf '%s|%s\n' "${f#./}" "$(sha256sum "$f" | cut -d' ' -f1)"
            done
    ) | sha256sum | cut -d' ' -f1
}

build_targets() {
    local rel
    TARGETS=()
    for rel in "${ALWAYS_TARGETS[@]}"; do TARGETS+=("$HOME/$rel"); done
    for rel in "${CANDIDATE_TARGETS[@]}"; do
        [ -d "$(dirname "$HOME/$rel")" ] && TARGETS+=("$HOME/$rel")
    done
}

# Every skill in the store: top-level dirs, then external/. Writes
# "name<TAB>path" lines. Two dirs with the same name is a store bug, reported
# rather than guessed at.
store_skills() {
    local d
    for d in "$STORE"/*/; do
        [ -d "$d" ] || continue
        is_skill "$d" || continue
        printf '%s\t%s\n' "$(basename "$d")" "${d%/}"
    done
    [ -d "$EXTERNAL" ] || return 0
    for d in "$EXTERNAL"/*/; do
        [ -d "$d" ] || continue
        is_skill "$d" || continue
        printf '%s\t%s\n' "$(basename "$d")" "${d%/}"
    done
}

build_targets

# ------------------------------------------------------------------------------
# 1. Store
# ------------------------------------------------------------------------------
if [ ! -d "$STORE/.git" ]; then
    if [ "$DRY" = 1 ]; then
        plan "clone $REPO -> $STORE"
    else
        info "cloning $REPO -> $STORE"
        git clone --progress "$REPO" "$STORE" || { warn "git clone failed"; exit 1; }
        ok 'store cloned'
    fi
fi

if [ "$NO_PULL" = 0 ] && [ "$DRY" = 0 ] && [ -d "$STORE/.git" ]; then
    # external/ is adopted on both machines, so the SAME skill can be downloaded
    # here and committed there. A plain `git pull` then aborts with "untracked
    # working tree files would be overwritten", and the sync never progresses.
    #
    # The tracked history is the authority -- it is what the other machine
    # deliberately committed -- so colliding untracked files are cleared out of
    # the way. Nothing is silently destroyed:
    #   identical content (checked through the index filters, so a CRLF checkout
    #   still matches an LF blob) is simply dropped;
    #   different content is MOVED to a backup directory outside the repo and
    #   the path is printed, because a version that differs is a decision for a
    #   human, not for this script.
    git -C "$STORE" fetch --quiet 2>/dev/null || true
    DROPPED=0
    BACKED_UP=0
    BACKUP_DIR=""
    while IFS= read -r rel; do
        [ -n "$rel" ] || continue
        incoming=$(git -C "$STORE" rev-parse --verify --quiet "FETCH_HEAD:$rel" 2>/dev/null) || continue
        [ -n "$incoming" ] || continue
        local=$(git -C "$STORE" hash-object --path="$rel" -- "$rel" 2>/dev/null) || continue
        if [ "$local" = "$incoming" ]; then
            rm -f "$STORE/$rel"
            DROPPED=$((DROPPED+1))
        else
            if [ -z "$BACKUP_DIR" ]; then
                BACKUP_DIR="$HOME/.cache/skills-sync/$(date +%Y%m%d-%H%M%S)"
                mkdir -p "$BACKUP_DIR"
            fi
            mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
            mv "$STORE/$rel" "$BACKUP_DIR/$rel"
            BACKED_UP=$((BACKED_UP+1))
        fi
    done < <(git -C "$STORE" ls-files --others --exclude-standard)
    [ "$DROPPED" -gt 0 ] && info "dropped $DROPPED untracked file(s) identical to the incoming commit"
    if [ "$BACKED_UP" -gt 0 ]; then
        warn "$BACKED_UP untracked file(s) differed from the incoming commit; moved to $BACKUP_DIR"
    fi

    # --rebase --autostash: the store's files are also the live files, so a local
    # edit is routine rather than exceptional.
    if ! git -C "$STORE" pull --rebase --autostash --quiet; then
        warn 'git pull failed in the store; continuing with the local copy'
        FAILURES+=('git pull')
    fi
fi

if [ "$PULL_ONLY" = 1 ]; then
    [ ${#FAILURES[@]} -gt 0 ] && exit 1
    ok 'store up to date'
    exit 0
fi

[ -d "$STORE" ] || { warn "store $STORE does not exist"; exit 1; }

# name -> path, for "is this skill already in the store" and for linking.
declare -A STORE_PATH=()
load_store() {
    STORE_PATH=()
    while IFS=$'\t' read -r n p; do
        [ -n "${n:-}" ] || continue
        if [ -n "${STORE_PATH[$n]:-}" ] && [ "${STORE_PATH[$n]}" != "$p" ]; then
            CONFLICTS+=("store has two '$n' skills: ${STORE_PATH[$n]} and $p")
            continue
        fi
        STORE_PATH[$n]="$p"
    done < <(store_skills)
}
load_store

# ------------------------------------------------------------------------------
# 2. Adopt
#
# Anything real sitting in a harness dir belongs in the store. Move it, then let
# step 3 link it back -- the harness keeps working and the files gain history.
# ------------------------------------------------------------------------------
[ -d "$EXTERNAL" ] || { [ "$DRY" = 1 ] && plan "create $EXTERNAL" || mkdir -p "$EXTERNAL"; }

declare -A REPLACE=()
declare -A PLANNED_FROM=()

for target in "${TARGETS[@]}"; do
    [ -d "$target" ] || continue
    for entry in "$target"/*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        [ -d "$entry" ] || continue
        name=$(basename "$entry")
        case "$name" in .*) continue ;; esac     # codex .system, editor dirs
        [ -L "$entry" ] && continue              # ours already
        is_skill "$entry" || { skip "$entry (no SKILL.md)"; continue; }

        if [ -n "${STORE_PATH[$name]:-}" ]; then
            other="${PLANNED_FROM[$name]:-${STORE_PATH[$name]}}"
            if [ -d "$other" ] && [ "$(dir_hash "$other")" = "$(dir_hash "$entry")" ]; then
                # Same skill installed twice. The store copy wins and this one
                # becomes a link -- that is what dedupes the legacy installs.
                REPLACE["$entry"]=1
                skip "$entry (identical to store; replaced by a link)"
            else
                CONFLICTS+=("$name differs: store=$other harness=$entry -- left alone")
            fi
            continue
        fi

        if [ "$DRY" = 1 ]; then
            plan "adopt $entry -> external/$name"
            # Record it so a later target holding the same skill is compared
            # against it instead of being adopted a second time.
            PLANNED_FROM["$name"]="$entry"
            STORE_PATH["$name"]="$EXTERNAL/$name"
            ADOPTED+=("$name")
            continue
        fi
        if mv "$entry" "$EXTERNAL/$name"; then
            ADOPTED+=("$name")
            STORE_PATH["$name"]="$EXTERNAL/$name"
        else
            warn "could not adopt $entry"
            FAILURES+=("adopt $name")
        fi
    done
done

# ------------------------------------------------------------------------------
# 3. Link
#
# Everything in the store, into every target. A link that already points at the
# right place is left alone, so a no-op run is a no-op.
# ------------------------------------------------------------------------------
for target in "${TARGETS[@]}"; do
    if [ ! -d "$target" ]; then
        if [ "$DRY" = 1 ]; then plan "create $target"; else mkdir -p "$target"; info "created $target"; fi
    fi

    for name in "${!STORE_PATH[@]}"; do
        dest="${STORE_PATH[$name]}"
        link="$target/$name"

        if [ -L "$link" ]; then
            current=$(readlink -f "$link" 2>/dev/null || true)
            if [ "$current" = "$(readlink -f "$dest")" ]; then continue; fi
        elif [ -e "$link" ]; then
            if [ -n "${REPLACE[$link]:-}" ]; then
                # Byte-identical duplicate of a store skill: dropping it and
                # linking is a pure dedupe, no content is lost.
                if [ "$DRY" = 1 ]; then plan "link $link -> $dest (replaces identical copy)"; LINKED=$((LINKED+1)); continue; fi
                rm -rf "$link" || { warn "could not replace $link"; continue; }
            else
                # A real directory adoption could not take (no SKILL.md, or a
                # conflict). Not ours to delete.
                is_skill "$link" && continue          # conflict already reported
                skip "$link (real dir, not a skill)"
                continue
            fi
        fi

        if [ "$DRY" = 1 ]; then plan "link $link -> $dest"; LINKED=$((LINKED+1)); continue; fi
        if ln -sfn "$dest" "$link"; then LINKED=$((LINKED+1))
        else warn "link failed: $link -> $dest"; FAILURES+=("link $name"); fi
    done

    # Prune: a link into the store whose skill is gone from it, or whose target
    # no longer exists. Anything not pointing into the store is left alone --
    # another tool's install is not ours to remove.
    for entry in "$target"/*; do
        [ -L "$entry" ] || continue
        current=$(readlink -f "$entry" 2>/dev/null || true)
        raw=$(readlink "$entry" 2>/dev/null || true)
        case "$raw" in
            "$STORE"/*) ;;
            *) continue ;;
        esac
        name=$(basename "$entry")
        [ -d "$current" ] && [ -n "${STORE_PATH[$name]:-}" ] && continue
        if [ "$DRY" = 1 ]; then plan "prune $entry (target gone from store)"; PRUNED+=("$entry"); continue; fi
        rm -f "$entry" && PRUNED+=("$entry")
    done
done

# ------------------------------------------------------------------------------
# 4. Push
#
# Only adopted skills create a commit: linking makes no file changes in the
# store, so there is nothing else to publish.
# ------------------------------------------------------------------------------
if [ "$PUSH" = 1 ]; then
    if [ "$DRY" = 1 ]; then
        plan "commit + push: ${ADOPTED[*]:-whatever is uncommitted under external/}"
    else
        git -C "$STORE" add --all -- external
        # Name what git actually staged, not what adoption moved this run: a push
        # that failed on a previous run leaves files staged-but-unpushed, and a
        # message naming one skill while the commit holds hundreds is a lie.
        mapfile -t SORTED < <(git -C "$STORE" diff --cached --name-only |
            sed -n "s|^external/\([^/]*\)/.*|\1|p" | sort -u)
        if [ ${#SORTED[@]} -eq 0 ]; then
            skip 'nothing to commit'
        else
            if [ ${#SORTED[@]} -eq 1 ]; then
                msg="feat(skills): add ${SORTED[0]}"
            else
                msg="feat(skills): add ${#SORTED[@]} skills"
            fi
            if ! git -C "$STORE" commit -q -m "$msg" -m "$(printf '%s, ' "${SORTED[@]}" | sed 's/, $//')"; then
                warn 'commit failed'; FAILURES+=('git commit')
            elif ! git -C "$STORE" push --quiet origin HEAD; then
                warn 'push failed (branch not published; run it again or push by hand)'
                FAILURES+=('git push')
            else
                ok "pushed ${#SORTED[@]} skill(s)"
            fi
        fi
    fi
fi

# ------------------------------------------------------------------------------
# 5. Report
# ------------------------------------------------------------------------------
TOTAL=${#STORE_PATH[@]}

if [ "$STATUS" = 1 ]; then
    CUSTOM=0
    for n in "${!STORE_PATH[@]}"; do
        case "${STORE_PATH[$n]}" in "$EXTERNAL"/*) ;; *) CUSTOM=$((CUSTOM+1)) ;; esac
    done
    printf '\n  store   %s\n' "$STORE"
    printf '  skills  %s (%s custom, %s external)\n' "$TOTAL" "$CUSTOM" "$((TOTAL-CUSTOM))"
    for t in "${TARGETS[@]}"; do
        linked=0; real=0; broken=0
        for e in "$t"/*; do
            [ -e "$e" ] || [ -L "$e" ] || continue
            if [ -L "$e" ]; then
                if [ -e "$e" ]; then linked=$((linked+1)); else broken=$((broken+1)); fi
            elif is_skill "$e"; then real=$((real+1)); fi
        done
        if [ "$linked" = "$TOTAL" ] && [ "$real" = 0 ] && [ "$broken" = 0 ]; then state='in sync'
        else state="linked=$linked real=$real broken=$broken"; fi
        printf '  %-34s %s\n' "${t/$HOME/\~}" "$state"
    done
    printf '\n'
fi

for c in "${CONFLICTS[@]:-}"; do [ -n "$c" ] && warn "$c"; done
for f in "${FAILURES[@]:-}"; do [ -n "$f" ] && warn "$f"; done

CHANGED=$(( ${#ADOPTED[@]} + LINKED + ${#PRUNED[@]} ))
if [ "$CHANGED" -eq 0 ]; then
    note "$TOTAL skills, ${#TARGETS[@]} targets, already in sync"
else
    [ ${#ADOPTED[@]} -gt 0 ] && ok "adopted ${#ADOPTED[@]}: $(printf '%s\n' "${ADOPTED[@]}" | sort -u | paste -sd, -)"
    [ "$LINKED" -gt 0 ] && ok "linked $LINKED entries across ${#TARGETS[@]} targets"
    [ ${#PRUNED[@]} -gt 0 ] && ok "pruned ${#PRUNED[@]}: $(printf '%s\n' "${PRUNED[@]}" | xargs -n1 basename | paste -sd, -)"
    note "$TOTAL skills -> ${#TARGETS[@]} targets"
fi

[ ${#FAILURES[@]} -gt 0 ] && [ -n "${FAILURES[0]:-}" ] && exit 1
exit 0
