#!/bin/bash
# Run the agent's Bash commands on the DEVICE, not on this server.
# PreToolUse hook — matcher: Bash
#
# The agent runs here, on the server, where it is installed and authenticated
# once. The code lives on the developer's machine. This hook is what bridges the
# two: it rewrites the command into an ssh through that device's reverse tunnel,
# and Claude Code re-executes the rewritten form and never learns the difference
# (`updatedInput`, proven in the plan's PoC).
#
# THIS IS A SERVER-SIDE BUNDLE. It must never be installed by `jonggrang init`,
# which also lands on the device — a redirect hook there would send commands to
# the machine it is already running on.
#
# It is inert unless the spawn set the device env, so a stray copy does nothing.

set -euo pipefail

INPUT=$(cat)

PORT="${JONGGRANG_DEVICE_PORT:-}"
USER_AT="${JONGGRANG_DEVICE_USER:-}"
WORKDIR="${JONGGRANG_DEVICE_WORKDIR:-}"
KEY="${JONGGRANG_DEVICE_KEY:-}"

# Not a device project (or a copy that wandered) — leave the command alone.
[ -z "$PORT" ] || [ -z "$USER_AT" ] || [ -z "$WORKDIR" ] || [ -z "$KEY" ] && exit 0

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')
[ -z "$COMMAND" ] && exit 0

# Already ours: never wrap twice.
case "$COMMAND" in
  *"-i $KEY"*) exit 0 ;;
esac

# The device's toolchain usually sits behind a version manager sourced from an rc
# file, and zsh reads .zshrc only when interactive — so the command goes through
# an interactive login shell or `node` is simply not found.
#
# jq's @sh does the quoting: the command keeps its own shell syntax inside one
# argument, and a quote in it cannot end the string early.
# The interactive shell above needs a tty (-tt below), and a tty makes git page
# its output — the agent gets half a screen and a pager waiting for a keypress it
# cannot send, then spends a turn discovering why. Nothing here is read by a human.
REMOTE=$(jq -rn --arg wd "$WORKDIR" --arg c "$COMMAND" \
  '"cd " + ($wd|@sh) + " || exit 1; export GIT_PAGER=cat PAGER=cat; exec \"$SHELL\" -lic " + ($c|@sh)')

REWRITTEN=$(jq -rn --arg r "$REMOTE" --arg p "$PORT" --arg u "$USER_AT" --arg k "$KEY" \
  '"ssh -tt -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
   + " -o LogLevel=QUIET -o ServerAliveInterval=30 -p " + $p + " -i " + ($k|@sh) + " " + $u + "@localhost "
   + ($r|@sh)')

jq -n --arg cmd "$REWRITTEN" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    updatedInput: { command: $cmd }
  }
}'
