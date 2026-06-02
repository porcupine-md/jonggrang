#!/bin/sh
set -e

chown root:root /root/.ssh/authorized_keys 2>/dev/null || true
chmod 600 /root/.ssh/authorized_keys 2>/dev/null || true

exec /usr/sbin/sshd -D -e
