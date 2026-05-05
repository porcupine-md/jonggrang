#!/usr/bin/env bash
set -euo pipefail

# ─── Colors ────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

PASS=0
FAIL=0

pass() { echo -e "  ${GREEN}✅${NC} $1"; ((PASS++)) || true; }
fail() { echo -e "  ${RED}❌${NC} $1"; ((FAIL++)) || true; }
info()  { echo -e "${CYAN}▶${NC}  $1"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $1"; }

# ─── Parse args ────────────────────────────────────────────────
QUICK=false
SYNTAX_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --quick)       QUICK=true ;;
    --syntax-only) SYNTAX_ONLY=true ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo ""
echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo -e "${CYAN}  Jonggrang Check${NC}"
echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo ""

# ─── 1. Syntax Check ──────────────────────────────────────────
info "Syntax check (node --check)..."

# Server & lib
for f in server.js lib/*.js bin/*.js; do
  if [ -f "$f" ]; then
    node --check "$f" 2>/dev/null && pass "$f" || fail "$f"
  fi
done

# Client JS files (skip .vue — verified by vite build)
CLIENT_JS_FILES=(
  client/src/main.js
  client/src/composables/useJonggrangApi.js
  client/src/composables/useJonggrangActions.js
  client/src/composables/useJonggrangRuntime.js
  client/src/composables/useLogTerminal.js
  client/src/utils/appUi.js
  client/src/utils/taskGraph.js
)
for f in "${CLIENT_JS_FILES[@]}"; do
  if [ -f "$f" ]; then
    node --check "$f" 2>/dev/null && pass "$f" || fail "$f"
  else
    warn "missing: $f"
  fi
done

echo ""

# ─── 2. Build Check ───────────────────────────────────────────
if $SYNTAX_ONLY; then
  info "Skipping build (--syntax-only)"
else
  info "Vite production build..."
  if npm run build --silent 2>&1 | tail -5; then
    pass "build"
  else
    fail "build"
  fi
fi

# ─── 3. (Future) Lint ─────────────────────────────────────────
# TODO: add eslint when adopted
# info "ESLint..."
# npx eslint client/src/ 2>&1 && pass "lint" || fail "lint"

echo ""
echo -e "${CYAN}──────────────────────────────────────────${NC}"
echo -e "  Passed: ${GREEN}${PASS}${NC}  Failed: ${RED}${FAIL}${NC}"
echo -e "${CYAN}──────────────────────────────────────────${NC}"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo -e "${RED}Checks failed.${NC}"
  exit 1
else
  echo ""
  echo -e "${GREEN}All checks passed. ✅${NC}"
fi
