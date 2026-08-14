#!/usr/bin/env bash
# E2E for `jonggrang design` — exercises the real CLI against an isolated store.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
export JONGGRANG_HOME="$TMP/home"; mkdir -p "$JONGGRANG_HOME"
JG=(node "$ROOT/bin/jonggrang.js")
fail=0
ok(){ echo "  ✓ $1"; }
bad(){ echo "  ✗ $1"; fail=1; }

echo "== new / list / get / validate =="
"${JG[@]}" design new acme --intent "Acme brand" --shapes dashboard,landing-page >/dev/null 2>&1 || bad "design new"
[ -f "$JONGGRANG_HOME/design/acme/manifest.yml" ] && ok "scaffolded manifest+tokens+guide" || bad "scaffold files missing"
"${JG[@]}" design list --json 2>/dev/null | grep -q '"id":"acme"' && ok "list shows acme" || bad "list"
"${JG[@]}" design acme get tokens 2>/dev/null | grep -q -- '--ui-action' && ok "get tokens" || bad "get tokens"
"${JG[@]}" design acme get guide 2>/dev/null | grep -q '## Source map' && ok "get guide has canonical sections" || bad "get guide"
"${JG[@]}" design acme get manifest 2>/dev/null | grep -q 'id: acme' && ok "get manifest" || bad "get manifest"
"${JG[@]}" design validate acme >/dev/null 2>&1 && ok "validate ok" || bad "validate"

echo "== component get =="
mkdir -p "$JONGGRANG_HOME/design/acme/components"
printf '<button style="background:var(--ui-action);border-radius:var(--ui-radius-control)">Go</button>\n' > "$JONGGRANG_HOME/design/acme/components/button.html"
node -e "const y=require('$ROOT/node_modules/js-yaml'),fs=require('fs');const p='$JONGGRANG_HOME/design/acme/manifest.yml';const m=y.load(fs.readFileSync(p,'utf8'));m.components=[{id:'button',file:'components/button.html',variants:['primary','quiet']}];fs.writeFileSync(p,y.dump(m))"
"${JG[@]}" design acme get button 2>/dev/null | grep -q '<button' && ok "get component (design <name> get button)" || bad "get component"
"${JG[@]}" design get acme button 2>/dev/null | grep -q '<button' && ok "get component (design get <name> button)" || bad "get component alt-syntax"

echo "== promote from a project =="
PROJ="$TMP/proj"; mkdir -p "$PROJ/.jonggrang" "$PROJ/src/theme"
printf ':root{--ui-action:oklch(0.4 0.1 255)}\n' > "$PROJ/src/theme/tokens.css"
node -e "const ui=require('$ROOT/lib/ui-context'),fs=require('fs');const g='---\nformat: jonggrang-ui-guide/v1\nbaseline: existing-project\ntoken_source: src/theme/tokens.css\ntoken_status: ready\ndescription: promoted brand\n---\n\n'+ui.REQUIRED_GUIDE_SECTIONS.map(s=>'## '+s+'\n\nbody').join('\n\n')+'\n';fs.writeFileSync('$PROJ/.jonggrang/UI.md',g)"
"${JG[@]}" design promote promoted --from "$PROJ" >/dev/null 2>&1 && ok "promote --from" || bad "promote"
"${JG[@]}" design validate promoted >/dev/null 2>&1 && ok "promoted validates" || bad "promoted invalid"
"${JG[@]}" design promoted get tokens 2>/dev/null | grep -q -- '--ui-action' && ok "promoted carries project tokens" || bad "promoted tokens"

echo "== show / remove =="
"${JG[@]}" design show acme >/dev/null 2>&1 && ok "show" || bad "show"
"${JG[@]}" design remove acme >/dev/null 2>&1 && ok "remove" || bad "remove"
"${JG[@]}" design list --json 2>/dev/null | grep -q '"id":"acme"' && bad "acme still listed after remove" || ok "acme gone after remove"

echo "== help =="
"${JG[@]}" design --help 2>/dev/null | grep -q 'global, reusable design templates' && ok "help" || bad "help"

echo
if [ $fail -eq 0 ]; then echo "qa-design: ALL PASS"; else echo "qa-design: FAILURES"; fi
rm -rf "$TMP"
exit $fail
