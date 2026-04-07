#!/bin/bash

DROPLET_USER="claude-runner"
DROPLET_IP="142.93.181.243"
REMOTE_PORT=3001
LOCAL_PORT=3001
APP_DIR="~/apps/claude-web-app-v2"

# Kill any existing tunnel on this local port
existing_pid=$(lsof -ti tcp:$LOCAL_PORT -s TCP:LISTEN 2>/dev/null)
if [ -n "$existing_pid" ]; then
  echo "Closing existing process on port $LOCAL_PORT (PID $existing_pid)..."
  kill "$existing_pid" 2>/dev/null
  sleep 1
fi

# Start the server on the droplet if it's not already running
echo "Starting v2 server on droplet..."
ssh -o StrictHostKeyChecking=no "$DROPLET_USER@$DROPLET_IP" \
  "cd $APP_DIR && fuser 3001/tcp > /dev/null 2>&1 || nohup npm start > /tmp/claude-web-app-v2.log 2>&1 &"

sleep 2

# Open SSH tunnel in the background
echo "Setting up SSH tunnel: localhost:$LOCAL_PORT -> droplet:$REMOTE_PORT..."
ssh -o StrictHostKeyChecking=no \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -N -L "$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" \
    "$DROPLET_USER@$DROPLET_IP" &

TUNNEL_PID=$!
echo "Tunnel PID: $TUNNEL_PID"

# Wait for tunnel to be ready
for i in {1..10}; do
  if lsof -ti tcp:$LOCAL_PORT -s TCP:LISTEN > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Open in Chrome
echo "Opening http://localhost:$LOCAL_PORT in Chrome..."
open -a "Google Chrome" "http://localhost:$LOCAL_PORT"

echo "Tunnel is running (PID $TUNNEL_PID). Press Ctrl+C to close it."
wait $TUNNEL_PID
