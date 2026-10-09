#!/bin/bash
set -e

# Create data directory
# mkdir -p /data

# Start Rclone mount in background
# echo "Starting Rclone mount..."
# rclone mount webdav:/ /data --vfs-cache-mode full --dir-cache-time 1s --vfs-cache-max-size 10G &
# RCLONE_PID=$!

# # Wait for Rclone to mount
# while ! mountpoint -q /data; do
#   echo "Waiting for Rclone mount..."
#   sleep 1
# done
# echo "Rclone mount is ready."

# Create supervisor log directory
mkdir -p /var/log/supervisor
# Start supervisord to manage Plex and Node.js
echo "Starting supervisord..."
/usr/bin/supervisord -c /supervisord.conf &

exec /init