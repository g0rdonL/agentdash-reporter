#!/bin/bash
# AgentDash Reporter Installer / Uninstaller
# Usage:
#   Install:   curl -fsSL https://agentdash.ink/install.sh | bash
#   Uninstall: curl -fsSL https://agentdash.ink/install.sh | bash -s uninstall

set -e

INSTALL_DIR="$HOME/.agentdash/reporter"
CONFIG_PATH="$HOME/.agentdash/config.json"
PLIST_PATH="$HOME/Library/LaunchAgents/com.agentdash.reporter.plist"
REPO_URL="https://raw.githubusercontent.com/g0rdonL/agentdash-reporter/main"

OS="$(uname)"

# Uninstall path
if [ "$1" = "uninstall" ] || [ "$1" = "--uninstall" ]; then
  echo "AgentDash Reporter Uninstaller"
  echo "=============================="
  if [ "$OS" = "Darwin" ]; then
    echo "Stopping and removing LaunchAgent..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
  elif [ "$OS" = "Linux" ]; then
    echo "Stopping and disabling systemd user units..."
    systemctl --user disable --now agentdash-reporter.timer 2>/dev/null || true
    systemctl --user disable --now agentdash-reporter.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/agentdash-reporter.timer"
    rm -f "$HOME/.config/systemd/user/agentdash-reporter.service"
    systemctl --user daemon-reload 2>/dev/null || true
  fi

  echo "Removing reporter files at $INSTALL_DIR..."
  rm -rf "$INSTALL_DIR"

  echo "Uninstallation complete ✓"
  exit 0
fi

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

# Download reporter or copy local files if present
mkdir -p "$INSTALL_DIR"
if [ -f "./reporter.mjs" ] && [ -f "./utils.mjs" ]; then
  echo "Local files detected — copying to $INSTALL_DIR..."
  cp "./reporter.mjs" "$INSTALL_DIR/reporter.mjs"
  cp "./utils.mjs" "$INSTALL_DIR/utils.mjs"
  cp "./claude.mjs" "$INSTALL_DIR/claude.mjs"
  cp "./package.json" "$INSTALL_DIR/package.json"
  if [ -f "./agentdash-reporter.service" ]; then
    cp ./agentdash-reporter.service "$INSTALL_DIR/"
  fi
  if [ -f "./agentdash-reporter.timer" ]; then
    cp ./agentdash-reporter.timer "$INSTALL_DIR/"
  fi
else
  echo "Downloading reporter to $INSTALL_DIR..."
  curl -fsSL "$REPO_URL/reporter.mjs"   -o "$INSTALL_DIR/reporter.mjs"
  curl -fsSL "$REPO_URL/utils.mjs"      -o "$INSTALL_DIR/utils.mjs"
  curl -fsSL "$REPO_URL/claude.mjs"     -o "$INSTALL_DIR/claude.mjs"
  curl -fsSL "$REPO_URL/package.json"   -o "$INSTALL_DIR/package.json"
  if [ "$OS" = "Linux" ]; then
    curl -fsSL "$REPO_URL/agentdash-reporter.service" -o "$INSTALL_DIR/agentdash-reporter.service"
    curl -fsSL "$REPO_URL/agentdash-reporter.timer"   -o "$INSTALL_DIR/agentdash-reporter.timer"
  fi
fi
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
  "happy":  { "enabled": true },
  "kimi":   { "enabled": false },
  "claude": { "enabled": true }
}
EOF
  echo "Config saved ✓"
fi

if [ "$OS" = "Darwin" ]; then
  # Install launchd plist
  NODE_BIN=$(command -v node)
  mkdir -p "$(dirname "$PLIST_PATH")"
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
  <string>$HOME/.agentdash/reporter.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.agentdash/reporter.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
EOF

  # Load the plist on macOS
  if command -v launchctl &>/dev/null; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"
    echo "LaunchAgent installed and started ✓"
  else
    echo "Skipping launchctl (launchctl command not found) ✓"
  fi

  # Test run
  echo ""
  echo "Running reporter once to verify..."
  if node "$INSTALL_DIR/reporter.mjs" --verify; then
    echo ""
    echo "Installation complete!"
  else
    echo ""
    echo "Verification failed. Please check the failure reason above."
    exit 1
  fi
  echo ""
  echo "Sessions will report every 60 seconds."
  echo "View logs: tail -f $HOME/.agentdash/reporter.log"
  echo "Dashboard: https://agentdash.ink"

elif [ "$OS" = "Linux" ]; then
  # Linux systemd user service and timer install
  NODE_BIN=$(command -v node)
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  mkdir -p "$SYSTEMD_DIR"

  echo "Installing systemd user service & timer..."
  # Replace placeholders and write files
  sed -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
      -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
      -e "s|{{HOME}}|$HOME|g" \
      "$INSTALL_DIR/agentdash-reporter.service" > "$SYSTEMD_DIR/agentdash-reporter.service"

  cp "$INSTALL_DIR/agentdash-reporter.timer" "$SYSTEMD_DIR/agentdash-reporter.timer"

  echo "Reloading systemd daemon..."
  systemctl --user daemon-reload || true

  echo "Enabling and starting timer..."
  systemctl --user enable --now agentdash-reporter.timer || {
    echo ""
    echo "Warning: Could not connect to systemd user bus to enable/start the timer."
    echo "This can happen if you are in a non-interactive shell or container."
    echo "To enable and start the timer manually in your user session, run:"
    echo "  systemctl --user enable --now agentdash-reporter.timer"
  }

  echo "Systemd user units installed and timer started ✓"

  # Test run
  echo ""
  echo "Running reporter once to verify..."
  if node "$INSTALL_DIR/reporter.mjs" --verify; then
    echo ""
    echo "Installation complete!"
  else
    echo ""
    echo "Verification failed. Please check the failure reason above."
    exit 1
  fi
  echo ""
  echo "Sessions will report every 60 seconds."
  echo "View logs: journalctl --user -u agentdash-reporter"
  echo "Dashboard: https://agentdash.ink"

else
  echo "Unsupported OS: $OS"
  exit 1
fi
