#!/usr/bin/env bash
# Checks .handoff/plan.md against the real repo before a handoff runs.
#   bash ~/.claude/skills/pi-handoff/check-plan.sh            (from the repo's top-level directory)
# Fails (exit 1) when:
#   - a "## Files to touch" entry does not exist as a tracked file, unless it ends in "(new)";
#   - an entry marked "(new)" already exists.
# An entry with a placeholder such as <slug> is skipped (the executor picks the name).
# Warns, without failing, about repo paths named in backticks elsewhere in the plan that are not
# tracked files: steps often shorten or relativise a path, so that scan is only a hint.
# Files to touch entries are list lines whose first backticked text is the path:
#   - `tools/arranger/lib.mjs`
#   - `tools/arranger/new-song.mjs` (new)
set -uo pipefail
PLAN=.handoff/plan.md
[ -f "$PLAN" ] || { echo "check-plan: no $PLAN in $(pwd)"; exit 1; }
git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "check-plan: not in a git repo"; exit 1; }

fail=0
entries=$(awk '/^## Files to touch/{f=1;next} /^## /{f=0} f' "$PLAN" | grep -E '^\s*- ')
[ -n "$entries" ] || { echo "check-plan: '## Files to touch' has no list entries"; exit 1; }

declare -A NEW=() LISTED=()
while IFS= read -r line; do
  path=$(printf '%s' "$line" | grep -oE '`[^`]+`' | head -1 | tr -d '`')
  [ -n "$path" ] || { echo "FAIL  no backticked path in: $line"; fail=1; continue; }
  LISTED[$path]=1
  [ "$path" = ".handoff/report.md" ] && continue
  case "$path" in *'<'*'>'*) echo "skip  $path (placeholder)"; continue ;; esac
  if printf '%s' "$line" | grep -qE '\(new[),]'; then
    NEW[$path]=1
    if [ -e "$path" ]; then echo "FAIL  $path is marked (new) but already exists"; fail=1
    else echo "ok    $path (new)"; fi
  elif git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "ok    $path"
  else
    echo "FAIL  $path is not a tracked file (mark it (new) if the plan creates it)"; fail=1
  fi
done <<< "$entries"

# Every repo-relative path in backticks anywhere in the plan must be real or a (new) entry.
# Skips absolute paths, home paths, URLs, globs and placeholders like <slug>.
while IFS= read -r p; do
  case "$p" in /*|~*|http*|*'<'*|*'*'*|*' '*|.handoff/*) continue ;; esac
  [ -n "${NEW[$p]:-}" ] && continue
  if git ls-files --error-unmatch "$p" >/dev/null 2>&1 || [ -d "$p" ]; then continue; fi
  echo "warn  the plan names \`$p\`, which is not a tracked file (check the path)"
done < <(grep -oE '`[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+`' "$PLAN" | tr -d '`' | sort -u)

if [ "$fail" -ne 0 ]; then echo "check-plan: FAILED - fix .handoff/plan.md before running"; exit 1; fi
echo "check-plan: passed (${#LISTED[@]} files to touch, ${#NEW[@]} new)"
