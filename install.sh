#!/bin/bash
# AgentDash Reporter Installer for macOS
# Usage: curl -fsSL https://agentdash.ink/install.sh | bash

set -e

INSTALL_DIR="$HOME/.agentdash/reporter"
CONFIG_PATH="$HOME/.agentdash/config.json"
PLIST_PATH="$HOME/Library/LaunchAgents/com.agentdash.reporter.plist"
REPO_URL="https://raw.githubusercontent.com/g0rdonL/agentdash-reporter/main"

echo "AgentDash Reporter Installer"
echo "============================"

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "Error: Node.js not found. Install from https://nodejs.org (v18+)"
  exit 1
fi
NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "Error: Node.js v18+ required (found $(node --version))"
  exit 1
fi
echo "Node.js: $(node --version) ✓"

# Download reporter
mkdir -p "$INSTALL_DIR"
echo "Downloading reporter to $INSTALL_DIR..."
curl -fsSL "$REPO_URL/reporter.mjs"   -o "$INSTALL_DIR/reporter.mjs"
curl -fsSL "$REPO_URL/package.json"   -o "$INSTALL_DIR/package.json"
chmod +x "$INSTALL_DIR/reporter.mjs"
echo "Downloaded ✓"

# Configure API key
if [ -f "$CONFIG_PATH" ]; then
  echo "Existing config found at $CONFIG_PATH — keeping it"
else
  echo ""
  echo "Get your API key at https://agentdash.ink/settings/api-keys"
  printf "Enter your API key: "
  read -r API_KEY
  if [[ "$API_KEY" != ad_live_* ]]; then
    echo "Error: API key must start with 'ad_live_'"
    exit 1
  fi
  mkdir -p "$(dirname "$CONFIG_PATH")"
  cat > "$CONFIG_PATH" <<EOF
{
  "api_key": "$API_KEY",
  "api_url": "https://agentdash.ink",
  "happy": { "enabled": true },
  "kimi":  { "enabled": false }
}
EOF
  echo "Config saved ✓"
fi

# Install launchd plist
NODE_BIN=$(command -v node)
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agentdash.reporter</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$INSTALL_DIR/reporter.mjs</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/agentdash-reporter.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/agentdash-reporter.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
EOF

# Load the plist
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
echo "LaunchAgent installed and started ✓"

# Test run
echo ""
echo "Running reporter once to verify..."
node "$INSTALL_DIR/reporter.mjs" && echo "" && echo "Installation complete!"
echo ""
echo "Sessions will report every 60 seconds."
echo "View logs: tail -f /tmp/agentdash-reporter.log"
echo "Dashboard: https://agentdash.ink"
