#!/usr/bin/env bash
# Web-based QA for the repo-tracked memory layer (#79, PR #80).
#
# ⚠️  HONEST SCOPE: memory layer is CLI-only. There is NO /api/memory endpoint
#     and NO MemoryView.vue yet. This script tests that memory files are
#     ACCESSIBLE via the existing web dashboard surfaces:
#       - Files API (browse + read MEMORY.md)
#       - Manifest API (feature folder listing — MEMORY.md co-exists)
#     A real web memory integration (dedicated endpoint + view) is a follow-up.
#
# What it does:
#   1. Creates a temp repo with pre-seeded memory files (project + feature MEMORY.md)
#   2. Registers the project with the web dashboard
#   3. Starts the web server on a test port
#   4. Curls API endpoints + asserts responses
#   5. Cleans up (server, temp repo, project registration)
#
# No agent needed — memory files are pre-seeded manually (deterministic).
#
# Usage:
#   bash scripts/qa-memory-web.sh
#   PORT=8888 bash scripts/qa-memory-web.sh   # custom port

set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-7999}"
HOST="127.0.0.1"
BASE="http://$HOST:$PORT/api"

PASS=0; FAIL=0
B="\\033[1m"; G="\\033[32m"; R="\\033[31m"; Y="\\033[33m"; C="\\033[36m"; N="\\033[0m"

section() { printf "\n${B}${C}════════════════════════════════════════════════════════════${N}\n${B}${C}  SCENARIO %s${N}\n${B}${C}  %s${N}\n${B}${C}════════════════════════════════════════════════════════════${N}\n" "$1" "$2"; }
step()     { printf "\n${B}── %s ──${N}\n" "$1"; }
show()     { printf "${Y}▶ %s${N}\n" "$1"; }
assert()   { local d="$1"; shift; if eval "$@" >/dev/null 2>&1; then
  printf "  ${G}✓ assert: %s${N}\n" "$d"; PASS=$((PASS+1))
else
  printf "  ${R}✗ assert: %s${N}\n" "$d"; FAIL=$((FAIL+1)); fi
}

# ── setup: temp repo with pre-seeded memory ────────────────────
T=$(mktemp -d)
PROJ_NAME="qa-memory-web"
PROJ_ID="proj_qa_memory_web_$$"
FID="feat-billing"

step "Create temp repo with pre-seeded memory files"
cd "$T" && git init -q && git commit -q --allow-empty -m init
printf '.jonggrang/.ephemeral/\n.jonggrang/codemap/\n' > .gitignore
mkdir -p ".jonggrang/.output/features/$FID"
echo '{"name":"qa-memory-web","project":{"stack":"node"}}' > .jonggrang/jonggrang.json
echo "{\"tasks\":[{\"id\":\"task-001\",\"title\":\"add idempotency\",\"status\":\"completed\",\"feature_id\":\"$FID\",\"skill\":\"backend\"}]}" \
  > ".jonggrang/.output/features/$FID/jonggrang-tasks.json"

# Pre-seed project memory (as promote would produce)
cat > .jonggrang/MEMORY.md << EOF
---
updated_at: 2026-07-05T10:00:00Z
scope: project
tags: [billing, backend, idempotency, background-jobs]
---

## Known Pitfalls
- Adding retry logic to a financial or background job without job-boundary
  idempotency causes silent duplicate processing
  ([feat-billing](.jonggrang/.output/features/$FID/MEMORY.md)).
EOF

# Pre-seed feature memory (as compact would produce)
cat > ".jonggrang/.output/features/$FID/MEMORY.md" << EOF
---
feature_id: $FID
feature_name: Billing Reconciliation
tags: [billing, backend, idempotency, reconciliation, background-jobs]
updated_at: 2026-07-05T10:00:00Z
---

## What Done & Why
- Added a job-level idempotency key to the reconciliation job
  ([task-001](.jonggrang/.output/features/$FID/jonggrang-tasks.json)).

## Lessons Learned
- For financial/background jobs, require idempotency at the job boundary
  BEFORE adding retry logic
  ([task-001](.jonggrang/.output/features/$FID/jonggrang-tasks.json)).
EOF

# Minimal MANIFEST.yaml so the manifest API surfaces this feature folder
# (MEMORY.md co-exists alongside it). Without this the endpoint 404s.
cat > ".jonggrang/.output/features/$FID/MANIFEST.yaml" << EOF
feature_id: $FID
description: Billing Reconciliation
work_type: SMALL
status: completed
current_phase: 17
active_phases: [1, 8, 17]
phases:
  1: { name: setup, status: completed }
  8: { name: implement, status: completed }
  17: { name: completion, status: completed }
EOF

show "Temp repo: $T"
show "Project ID: $PROJ_ID"

# ── register project with web dashboard ───────────────────────
step "Register project with web dashboard (via web-state module)"
node -e "
const ws = require('$REPO/lib/web-state.js');
ws.createProject({
  id: '$PROJ_ID',
  name: '$PROJ_NAME',
  path: '$T',
  source: { type: 'local', path: '$T', link_mode: 'reference' },
  init_status: 'ready',
  lanes: { main: { id: 'main', path: '$T', branch: 'main', is_main: true } },
  created_at: new Date().toISOString(),
});
console.log('registered');
" || { echo "FAILED to register project"; exit 1; }

# ── start web server ───────────────────────────────────────────
step "Start web server on port $PORT"
JONGGRANG_HOME="$HOME/.jonggrang" PORT="$PORT" HOST="$HOST" \
  node "$REPO/server.js" > /tmp/qa-memory-web-server.log 2>&1 &
SERVER_PID=$!
show "Server PID: $SERVER_PID"

# wait for server ready (max 15s)
show "Waiting for server ready..."
for i in $(seq 1 15); do
  if curl -sf "$BASE/projects" >/dev/null 2>&1; then
    show "Server ready (after ${i}s)"
    break
  fi
  sleep 1
  [ "$i" -eq 15 ] && { echo "${R}Server did not start${N}"; cat /tmp/qa-memory-web-server.log; FAIL=$((FAIL+1)); exit 1; }
done

# cleanup trap
cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  node -e "try { require('$REPO/lib/web-state.js').deleteProject('$PROJ_ID'); } catch(e){}"
  rm -rf "$T"
}
trap cleanup EXIT

# ════════════════════════════════════════════════════════════════
# SCENARIO 1: Project listed in dashboard
# ════════════════════════════════════════════════════════════════
section "1" "Project listed in dashboard"
RESP=$(curl -sf "$BASE/projects")
echo "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0));const p=d.projects.find(x=>x.id==='$PROJ_ID');console.log(p?'found: '+p.name:'NOT FOUND')"
assert "project in /api/projects list" "echo '$RESP' | grep -q '$PROJ_ID'"

# ════════════════════════════════════════════════════════════════
# SCENARIO 2: Project memory browsable + readable via Files API
# ════════════════════════════════════════════════════════════════
section "2" "Project MEMORY.md browsable + readable via Files API"
step "GET /projects/:id/files?path=.jonggrang — list .jonggrang contents"
RESP=$(curl -sf "$BASE/projects/$PROJ_ID/files?path=.jonggrang")
echo "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0));const names=d.entries.map(e=>e.name);console.log(names.join(', '))"
assert "MEMORY.md in .jonggrang listing" "echo '$RESP' | grep -q 'MEMORY.md'"

step "GET /projects/:id/files/content?path=.jonggrang/MEMORY.md — read content"
RESP=$(curl -sf "$BASE/projects/$PROJ_ID/files/content?path=.jonggrang/MEMORY.md")
echo "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.content.slice(0,120)+'...')"
assert "project memory content readable" "echo '$RESP' | grep -q 'scope: project'"
assert "project memory has markdown link" "echo '$RESP' | grep -q 'feat-billing](.jonggrang/.output/features/'"
assert "project memory has tags" "echo '$RESP' | grep -q 'tags:.*idempotency'"

# ════════════════════════════════════════════════════════════════
# SCENARIO 3: Feature memory browsable + readable
# ════════════════════════════════════════════════════════════════
section "3" "Feature MEMORY.md browsable + readable via Files API"
step "GET /projects/:id/files?path=.jonggrang/.output/features/$FID — list feature folder"
RESP=$(curl -sf "$BASE/projects/$PROJ_ID/files?path=.jonggrang/.output/features/$FID")
echo "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0));const names=d.entries.map(e=>e.name);console.log(names.join(', '))"
assert "MEMORY.md in feature folder listing" "echo '$RESP' | grep -q 'MEMORY.md'"
assert "jonggrang-tasks.json in feature folder" "echo '$RESP' | grep -q 'jonggrang-tasks.json'"

step "GET /projects/:id/files/content?path=.jonggrang/.output/features/$FID/MEMORY.md"
RESP=$(curl -sf "$BASE/projects/$PROJ_ID/files/content?path=.jonggrang/.output/features/$FID/MEMORY.md")
echo "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.content.slice(0,150)+'...')"
assert "feature memory content readable" "echo '$RESP' | grep -q 'feature_id: $FID'"
assert "feature memory has markdown link to task" "echo '$RESP' | grep -q 'task-001](.jonggrang/.output/features/'"
assert "feature memory has tags" "echo '$RESP' | grep -q 'tags:.*reconciliation'"

# ════════════════════════════════════════════════════════════════
# SCENARIO 4: Manifest API lists feature folder (MEMORY.md co-exists)
# ════════════════════════════════════════════════════════════════
section "4" "Manifest API lists feature folder (MEMORY.md co-exists)"
step "GET /projects/:id/manifest — feature folder discoverable"
RESP=$(curl -sf "$BASE/projects/$PROJ_ID/manifest")
echo "$RESP" | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(JSON.stringify(d).slice(0,200))"
assert "manifest returns feature folder" "echo '$RESP' | grep -q '$FID'"
show "Note: manifest API reads MANIFEST.yaml, not MEMORY.md. MEMORY.md co-exists in the folder but is not surfaced by this endpoint — that's a follow-up (dedicated /api/memory endpoint)."

# ════════════════════════════════════════════════════════════════
# SCENARIO 5: Memory files appear in git status (tracked, not ignored)
# ════════════════════════════════════════════════════════════════
section "5" "Memory files tracked in git (visible in Changes view)"
step "git add + status — MEMORY.md files appear as trackable"
cd "$T"
git add .jonggrang/MEMORY.md ".jonggrang/.output/features/$FID/MEMORY.md" 2>/dev/null
ST=$(git status --short)
echo "$ST"
assert "project MEMORY.md in git status" "echo '$ST' | grep -q '.jonggrang/MEMORY.md'"
assert "feature MEMORY.md in git status" "echo '$ST' | grep -q 'features/$FID/MEMORY.md'"
show "These would appear in the web Changes view as new tracked files."

cd "$REPO"

# ════════════════════════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════════════════════════
printf "\n${B}════════════════════════════════════════════════════════════${N}\n"
printf "${B}  WEB QA SUMMARY: %s passed, %s failed${N}\n" "$PASS" "$FAIL"
printf "${B}  Scope: memory files accessible via existing web surfaces${N}\n"
printf "${B}  (Files API + Manifest API + git tracking)${N}\n"
printf "${B}  No dedicated /api/memory endpoint or MemoryView yet${N}\n"
printf "${B}════════════════════════════════════════════════════════════${N}\n"
[ "$FAIL" -eq 0 ] && printf "${G}ALL SCENARIOS GREEN${N}\n" || printf "${R}FAILURES PRESENT${N}\n"
exit $FAIL
