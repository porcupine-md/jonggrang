#!/usr/bin/env bash
set -euo pipefail

# Deterministic Codex runtime-wrapper smoke test.
# This does NOT call the real Codex CLI or any API. The test installs a temporary
# fake `codex` executable at the front of PATH and verifies Jonggrang's
# lib/jonggrang.js wrapper behavior against that fake JSONL stream.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node test/codex-runtime-integration.test.js
