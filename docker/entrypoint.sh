#!/bin/bash
set -e

# Start supervisord to manage Plex and Node.js
mkdir -p /var/log/supervisor
echo "Starting supervisord..."
/usr/bin/supervisord -c /supervisord.conf &

exec /init
