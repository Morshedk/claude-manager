#!/bin/bash
# PreToolUse hook on Bash: intercepts pm2 restart commands and shows CWD/port info
# so Claude doesn't restart the wrong server or deploy to the wrong place.

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')

# Only care about pm2 restart commands
if ! echo "$cmd" | grep -qE '^\s*pm2\s+restart'; then
  exit 0
fi

# Extract the process name from the command
proc=$(echo "$cmd" | grep -oP 'pm2\s+restart\s+\K\S+')

if [ -z "$proc" ]; then
  exit 0
fi

# Get pm2 info for the target process
info=$(pm2 info "$proc" 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "WARNING: pm2 process '$proc' not found. Check the process name." >&2
  exit 2
fi

cwd=$(echo "$info" | grep "exec cwd" | awk -F'│' '{print $3}' | xargs)
port=$(pm2 jlist 2>/dev/null | jq -r ".[] | select(.name==\"$proc\") | .pm2_env.PORT // empty")
script=$(echo "$info" | grep "script path" | awk -F'│' '{print $3}' | xargs)

echo "╔══════════════════════════════════════════════════════════════╗" >&2
echo "║  PM2 RESTART: $proc" >&2
echo "║  CWD:    $cwd" >&2
echo "║  Port:   ${port:-unknown}" >&2
echo "║  Script: $script" >&2
echo "╚══════════════════════════════════════════════════════════════╝" >&2

# Allow the restart — the info is printed so Claude (and user) can verify
exit 0
