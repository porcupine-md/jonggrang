#!/bin/sh
set -e

chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true

exec /usr/sbin/sshd -D -e
