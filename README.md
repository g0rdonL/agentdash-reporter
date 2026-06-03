# AgentDash Reporter

Watches your local AI coding sessions and reports their status to [AgentDash](https://agentdash.ink).

Runs every 60 seconds as a macOS background service (launchd). Zero runtime dependencies — just Node.js ≥ 18.

## Supported agents

| Agent | Detection method |
|-------|-----------------|
| [Happy](https://happy.engineering) | Happy daemon `/list` API |
| Kimi Code | Process scan (`pgrep`) |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/g0rdonL/agentdash-reporter/main/install.sh | bash
```

You'll be prompted for your API key from **agentdash.ink → Settings → API Keys**.

### What the installer does

1. Downloads `reporter.mjs` to `~/.agentdash/reporter/`
2. Writes a config to `~/.agentdash/config.json`
3. Installs a launchd plist at `~/Library/LaunchAgents/com.agentdash.reporter.plist`
4. Runs the reporter once to verify everything works

### Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.agentdash.reporter.plist
rm ~/Library/LaunchAgents/com.agentdash.reporter.plist
rm -rf ~/.agentdash/reporter
```

## Manual config

`~/.agentdash/config.json`:

```json
{
  "api_key": "ad_live_your_key_here",
  "api_url": "https://agentdash.ink",
  "happy": { "enabled": true },
  "kimi":  { "enabled": false }
}
```

## Logs

```bash
tail -f /tmp/agentdash-reporter.log
```

## License

MIT
