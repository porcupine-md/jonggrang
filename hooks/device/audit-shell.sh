#!/bin/sh
# Every command the server runs on this device passes through here, and is
# recorded before it runs.
#
# Installed ON THE DEVICE by `jonggrang device register`, and named as the forced
# command for the server's key. sshd hands the client's real command in
# $SSH_ORIGINAL_COMMAND, so this can log it and then run it — the developer's own
# machine keeps the record, which is the point: a log kept on the server is a log
# the server can rewrite.
#
# It is not a restriction. The server can still run anything; §7's remaining work
# (a scoped account, ephemeral keys) is what narrows that. This makes it visible.

LOG="${JONGGRANG_DEVICE_AUDIT_LOG:-$HOME/.jonggrang/device-audit.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null

# A rotation nobody has to remember: keep the tail when it gets large, so the log
# cannot quietly fill a laptop's disk.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 4194304 ]; then
  tail -c 1048576 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

STAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
FROM="${SSH_CONNECTION%% *}"

if [ -z "${SSH_ORIGINAL_COMMAND:-}" ]; then
  # No command means an interactive session — the dashboard's Terminal.
  printf '%s\tfrom=%s\tshell\n' "$STAMP" "${FROM:-?}" >> "$LOG"
  exec "$SHELL" -l
fi

printf '%s\tfrom=%s\t%s\n' "$STAMP" "${FROM:-?}" "$SSH_ORIGINAL_COMMAND" >> "$LOG"

# Run it exactly as asked. `$SHELL -c` and not `-lc`: the caller already decides
# whether it wants a login shell (the agent asks for one, so its version manager
# is found), and adding another layer here would change what it asked for.
exec "$SHELL" -c "$SSH_ORIGINAL_COMMAND"
