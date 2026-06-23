#!/usr/bin/env bash
# JONGGRANG — Commit Convention Enforcement Hook
# Claude Code PreToolUse hook (matcher: Bash)
#
# Validates that agent-authored commits follow the structured convention
# (see docs/COMMIT-CONVENTION.md). The `Co-authored-by:` trailer is the
# agent marker — its presence triggers field validation; its absence
# means a human commit and we pass through.
#
# Why lifecycle hook (not git commit-msg): the agent can read the
# block-reason in-context, reason about the missing fields, and retry
# with the correct format. A hard git hook can't recover gracefully.

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // ""')

[ -z "$COMMAND" ] && exit 0

# Flatten the command: lift $() / backtick contents onto their own lines,
# then split on chain operators so each segment is checked individually.
NORMALIZED=$(printf '%s' "$COMMAND" \
  | perl -pe 's/\$\(([^)]*)\)/\n$1\n/g; s/`([^`]*)`/\n$1\n/g; s/[()]/ /g' 2>/dev/null \
  || printf '%s' "$COMMAND" | sed -E 's/\$\(/ /g; s/[`()]/ /g')
SEGMENTS=$(printf '%s' "$NORMALIZED" | awk '{
  gsub(/&&/, "\n"); gsub(/\|\|/, "\n"); gsub(/;/, "\n"); gsub(/\|/, "\n"); print
}')

# Bail early if no segment is a `git commit` invocation.
HAS_COMMIT=false
while IFS= read -r seg; do
  seg=$(printf '%s' "$seg" | sed -E "s/^[[:space:]]+//; s/[[:space:]]+$//")
  echo "$seg" | grep -qE '^git[[:space:]]+commit\b' && HAS_COMMIT=true && break
done <<< "$SEGMENTS"

[ "$HAS_COMMIT" = "false" ] && exit 0

# ── Extract the commit message from the command ──────────────────────
# Supports: -m "msg" (single or multiple), -F file, --amend (read last commit).
extract_message() {
  local cmd="$1"

  # Collect all -m / --message arguments. First is the subject; remaining
  # -m args become body paragraphs (the standard git convention). Embedded
  # \n in shell strings are converted to real newlines for the check below.
  local msg
  msg=$(printf '%s' "$cmd" | perl -0777 -ne '
    my @parts;
    while (/(?:-m|--message)\s+["\x27]((?:[^"\\]|\\.)*)["\x27]/g) {
      my $v = $1;
      $v =~ s/\\n/\n/g;
      $v =~ s/\\t/\t/g;
      $v =~ s/\\(["\x27\\])/$1/g;
      push @parts, $v;
    }
    if (@parts) { print join("\n", @parts); }
  ')

  if [ -n "$msg" ]; then printf '%s' "$msg"; return; fi

  # -F / --file=<path> — read the message from a file. Matches all 4 forms:
  # `-F path`, `--file path`, `-F=path`, `--file=path`. Relative paths are
  # resolved against $PROJECT_ROOT (Claude Code's cwd) so this works whether
  # the agent writes the path relative to the repo or absolute.
  local file
  file=$(printf '%s' "$cmd" | perl -0777 -ne 'if (/--?(?:F|file)(?:\s+|\s*=\s*)["\x27]?([^\s"\x27]+)["\x27]?/) { print $1; exit; }')
  if [ -n "$file" ]; then
    local fpath="$file"
    if [[ "$fpath" != /* ]] && [ -n "$PROJECT_ROOT" ]; then
      fpath="$PROJECT_ROOT/$fpath"
    fi
    if [ -f "$fpath" ]; then cat "$fpath"; return; fi
  fi

  # --amend without an explicit -m override — validate the last commit's message.
  if printf '%s' "$cmd" | grep -qE -- '--amend\b'; then
    git log -1 --pretty=%B 2>/dev/null || true
    return
  fi
}

MESSAGE=$(extract_message "$COMMAND" || true)
[ -z "$MESSAGE" ] && exit 0

# ── Agent marker check ───────────────────────────────────────────────
# Co-authored-by trailer means an agent wrote this commit. Absent = human.
printf '%s' "$MESSAGE" | grep -qiE '^[[:space:]]*Co-authored-by:' || exit 0

# ── Validate required fields ─────────────────────────────────────────
# The 5 fields must appear at the start of a line. Values may be "none".
REQUIRED=(Context: What: Why: Tradeoff: Caveats:)
MISSING=()
for field in "${REQUIRED[@]}"; do
  printf '%s' "$MESSAGE" | grep -qiE "^[[:space:]]*${field}" \
    || MISSING+=("$field")
done

[ ${#MISSING[@]} -eq 0 ] && exit 0

# ── Build the block reason ───────────────────────────────────────────
deny() {
  printf '{"decision": "block", "reason": %s}\n' "$(printf '%s' "$1" | jq -Rs .)"
  exit 2
}

MISSING_LIST=$(printf '  - %s\n' "${MISSING[@]}")
REASON="COMMIT CONVENTION: agent commit is missing required structured field(s):

${MISSING_LIST}All 5 fields are required for agent commits. Use \"none\" if a field is genuinely N/A (e.g. typo fixes, version bumps).

Format:
  <type>: <short summary>

  Context: <narrative — feature or plan description, NOT an ID>
  What:    <change intent in prose — don't list files, MANIFEST tracks that>
  Why:     <rationale for the change>
  Tradeoff:<what was sacrificed, or 'none'>
  Caveats: <next-agent note, or 'none'>

  Co-authored-by: jonggrang <koko@jonggrang.dev>

See docs/COMMIT-CONVENTION.md (or CONTRIBUTING.md §3) for the full spec."

deny "$REASON"
