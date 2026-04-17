#!/usr/bin/env bash
# JONGGRANG — Output Location Enforcement Hook
# Claude Code SubagentStop hook
# Blocks sub-agent exit if output files are scattered outside .jonggrang/.output/
#
# Input (stdin): JSON { session_id, ... }
# Exit 0 = allow exit, Exit 2 = block with message

set -euo pipefail

INPUT=$(cat)
PROJECT_ROOT=$(echo "$INPUT" | jq -r '.cwd // (env.JONGGRANG_PROJECT_ROOT // "")')

if [[ -z "$PROJECT_ROOT" ]]; then
  exit 0
fi

VIOLATIONS=()

# ─── Check: New .md files outside approved locations ─────────────────────────
UNTRACKED=$(git -C "$PROJECT_ROOT" ls-files --others --exclude-standard 2>/dev/null || true)
STAGED=$(git -C "$PROJECT_ROOT" diff --name-only --cached 2>/dev/null || true)

# Combine and find .md files in wrong places
ALL_NEW=$(echo -e "$UNTRACKED\n$STAGED" | sort -u | grep '\.md$' || true)

ALLOWED_PATTERNS=(
  "^\.jonggrang/"
  "^AGENTS\.md$"
  "^CLAUDE\.md$"
  "^SKILL\.md$"
  "^progress\.txt$"
  "^README\.md$"
  "^CHANGELOG\.md$"
  "^CONTRIBUTING\.md$"
  "^docs/"
  "^\.claude/"
  "^\.opencode/"
)

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  allowed=false
  for pattern in "${ALLOWED_PATTERNS[@]}"; do
    if echo "$file" | grep -qE "$pattern"; then
      allowed=true
      break
    fi
  done
  if [[ "$allowed" == "false" ]]; then
    VIOLATIONS+=("Unapproved .md file: $file (should be in .jonggrang/.output/)")
  fi
done <<< "$ALL_NEW"

# ─── Check: Skill compliance marker in output files ──────────────────────────
OUTPUT_DIR="$PROJECT_ROOT/.jonggrang/.output"
if [[ -d "$OUTPUT_DIR" ]]; then
  # Check recent output .md files for jonggrang compliance header
  find "$OUTPUT_DIR" -name "*.md" -newer "$OUTPUT_DIR" -type f 2>/dev/null | head -5 | while read -r f; do
    if ! grep -q "jonggrang-output\|phase:\|feature_id:" "$f" 2>/dev/null; then
      echo "Output file missing jonggrang metadata: $f" >&2
    fi
  done
fi

# ─── Report ──────────────────────────────────────────────────────────────────
if [[ ${#VIOLATIONS[@]} -eq 0 ]]; then
  exit 0
fi

echo "=== OUTPUT LOCATION VIOLATIONS ==="
for v in "${VIOLATIONS[@]}"; do
  echo "  ✗ $v"
done
echo ""
echo "Move output files to .jonggrang/.output/features/{feature_id}/"
echo "{ \"decision\": \"block\", \"reason\": \"Output files in wrong location\" }"
exit 2
