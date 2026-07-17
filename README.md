# AgentDash Reporter

The AgentDash Reporter is a lightweight, zero-dependency Node.js service that monitors your local AI coding sessions and reports their status to [AgentDash](https://agentdash.ink). It acts as an emitter client, collecting local session events and reporting them in batches to the AgentDash status API.

## How It Works & Architecture
The reporter runs as a background service (macOS `launchd` or Linux `systemd`) every 60 seconds. During each run, it polls active agents from registered adapters and sends a JSON payload via an HTTP POST request to `<api_url>/api/v1/emitter/status/batch` with your `Authorization: Bearer <api_key>` header.

## Installation

To install the AgentDash Reporter:

### macOS (launchd)
Run the following command:
```bash
curl -fsSL https://agentdash.ink/install.sh | bash
```
This installs the reporter files to `~/.agentdash/reporter` and sets up a background LaunchAgent running every 60 seconds.
- **Log Location**: `~/.agentdash/reporter.log`
- **Manual Verification**: Run `node ~/.agentdash/reporter/reporter.mjs --verify`

### Linux (systemd)
Run the following command:
```bash
curl -fsSL https://agentdash.ink/install.sh | bash
```
This installs the reporter files to `~/.agentdash/reporter` and registers a user-level systemd service (`agentdash-reporter.service`) triggered by a systemd timer (`agentdash-reporter.timer`) every 60 seconds.
- **Log Location**: `journalctl --user -u agentdash-reporter`
- **Manual Verification**: Run `node ~/.agentdash/reporter/reporter.mjs`

---

## Uninstallation

To cleanly stop the reporter background service and remove all installed files (while preserving your configuration at `~/.agentdash/config.json`):

```bash
curl -fsSL https://agentdash.ink/install.sh | bash -s uninstall
```
*(Alternatively, if you have the repository or script locally: `./install.sh uninstall`)*

---

## Adapters

### Happy Adapter
* **Tool Detected:** Happy daemon (`happy.engineering`) and its child agents.
* **Session Discovery:** Resolves `happy.daemon_state_path` (default `~/.happy/daemon.state.json`) to find the HTTP port and heartbeat. If active, queries `http://127.0.0.1:<port>/list`. For each child session, checks if `pid` is alive via `kill -0 <pid>` and queries its working directory via `lsof -p <pid>`.
* **Emitted Fields:**
  * `agent_id`: `happySessionId`
  * `status`: `'running'`
  * `issue_title`: Session title from `happy.session_titles_path` (default `~/.happy/session-titles.json`) or the basename of `cwd`.
  * `progress_pct`: `100`
  * `step_name`: `"<flavor> · pid <pid>"` (flavor: `'claude'`, `'kimi'`, `'gemini'`, or `'codex'`).
  * `metadata`: `{ reporter_version, source: 'happy', flavor, path, host_pid }`

### Kimi Adapter
* **Tool Detected:** Running Kimi Code processes.
* **Session Discovery:** Runs process scanning via `pgrep -f 'Kimi Code'`. Discovers the session's working directory using `lsof -p <pid>`. Does not query or read any session files from disk.
* **Emitted Fields:**
  * `agent_id`: `"kimi-<pid>"`
  * `status`: `'running'`
  * `issue_title`: Cleaned basename of `cwd`.
  * `progress_pct`: `100`
  * `step_name`: `"kimi · pid <pid>"`
  * `metadata`: `{ reporter_version, source: 'kimi', path, host_pid }`

### Claude Code Adapter
* **Tool Detected:** Claude Code CLI processes and session files.
* **Session Discovery:**
  1. Process scans via `pgrep -f 'claude'` to find running Claude processes and their `cwd` using `lsof`.
  2. Scans `~/.claude/projects/` directory. Claude Code encodes project directories by replacing `/` and `.` with `-` (e.g. `-Users-gordon-dev-foo`).
  3. Inside each project directory, scans for `*.jsonl` session files. Parses the last line to extract `sessionId`, `timestamp`, and `cwd`. (If `cwd` is missing, scans up to 20 lines backward).
* **Emitted Fields:**
  * `agent_id`: `sessionId` from session file, or `"claude-<pid>"` if fileless.
  * `status`: `'running'`
  * `issue_title`: Cleaned basename of resolved directory.
  * `progress_pct`: `100`
  * `step_name`: `"claude · <state> · pid <pid>"` (where `state` is `'active'` or `'idle'`).
  * `metadata`: `{ reporter_version, source: 'claude', state, path, last_activity, host_pid }`

## Session State Derivation
The reporter code only emits a `status` of `'running'`. It has **no** native concept or state variables for `thinking`, `waiting`, or `disconnected`. State metadata is limited to:
* **`active`**: A Claude Code session with a running process (or any running Happy/Kimi session).
* **`idle`**: A Claude Code session without an active process, updated within the last 24 hours.

## Configuration & Environment Values
Config is loaded from `~/.agentdash/config.json`. The codebase reads the following keys:
* **`api_key`**: (Required) AgentDash API key starting with `ad_live_`. No default.
* **`api_url`**: Backend URL. Default: `"https://agentdash.ink"` (trailing slash is stripped).
* **`happy.enabled`**: Default: `true`.
* **`happy.daemon_state_path`**: Default: `"~/.happy/daemon.state.json"`.
* **`happy.session_titles_path`**: Default: `"~/.happy/session-titles.json"`.
* **`kimi.enabled`**: Default: `false`.
* **`claude.enabled`**: Default: `true`.
* **`HOME`**: The primary environment variable used to resolve path tildes (`~`) and locate config/cache files.

## Developer Interface & How to Run
### Running the Reporter
Run manually as a single-execution command:
```bash
node reporter.mjs
```
The background service runs it every 60s, logging output to `~/.agentdash/reporter.log` on macOS or `journalctl --user -u agentdash-reporter` on Linux.

### Adding a New Adapter
To add an adapter, write a session collection function that returns an array of events and register it in `reporter.mjs` inside the `main` function. Adapters must satisfy this contract:
1. **Input Interface:** Accept the parsed configuration object.
2. **Output Event Contract:** Return a Promise resolving to an array of event objects with:
   * `agent_id` (string), `status: 'running'`, `issue_title` (string), `progress_pct: 100`, `step_name` (string), and `metadata` (object).
3. **Utility reuse:** Use functions exported by `utils.mjs`:
   * `VERSION`: Current string version of the reporter.
   * `loadJson(path)`: Safely parses JSON files, returning null on error.
   * `resolvePath(path)`: Replaces `~` prefix with the user's home directory.
   * `pathName(path)`: Returns a clean path representation (handles `tmp`, `dev`, `worktree` gracefully).

## Failure Modes & Error Handling
* **Missing Config:** If `~/.agentdash/config.json` is missing or invalid, the process prints an error and exits (`exit 1`).
* **Missing Tool / Tool Not Installed:**
  * For Happy: If daemon file is missing, skipped. If `/list` fails, logs error and returns `[]`.
  * For Kimi/Claude: If `pgrep` throws (not installed / no matches), caught and returns `[]`.
* **Stale Happy Heartbeat:** If `daemonState.lastHeartbeat` is older than `120000`ms (2 minutes), logs `Happy daemon heartbeat stale — skipping` and returns `[]`.
* **Stale Claude Session:** If `lastActivity` is older than 24 hours and has no matching process, the session is ignored.
* **Unresolved Working Directory:** If `lsof` fails or the process lacks permissions, `cwd` defaults to `"unknown"`.
* **Network & API Errors:** Posting retries up to 3 times with progressive delay (`attempt * 500`ms). A `401` status terminates immediately (`exit 1`).

## Troubleshooting
All agentdash-reporter runtime output is consolidated into a single log file. One `tail -f` command shows both stdout and stderr.

### Log Path
```bash
tail -f ~/.agentdash/reporter.log
```

### Self-Verification Command
Verify your agentdash-reporter installation health and configuration directly using:
```bash
node ~/.agentdash/reporter/reporter.mjs --verify
```

### 3 Most Likely Failure Modes & Exact Log Lines

1. **Missing Configuration File**
   * **Cause:** The configuration file does not exist at `~/.agentdash/config.json`.
   * **Exact Log Output (on verify):**
     ```
     FAIL: config missing (not found at ~/.agentdash/config.json)
     ```

2. **Invalid API Key**
   * **Cause:** The API key in the configuration is missing, does not start with `ad_live_`, or has been rejected by the backend server.
   * **Exact Log Output (on verify - local pattern validation failure):**
     ```
     FAIL: bad api_key (must start with "ad_live_")
     ```
   * **Exact Log Output (on verify - server auth failure):**
     ```
     FAIL: bad api_key
     ```

3. **Backend Unreachable / Network Issue**
   * **Cause:** The host is offline, DNS resolution failed, or the backend returned a non-2xx status code.
   * **Exact Log Output (on verify - network error):**
     ```
     FAIL: network error (getaddrinfo ENOTFOUND agentdash.ink)
     ```
   * **Exact Log Output (on verify - backend error response):**
     ```
     FAIL: backend error (HTTP 502)
     ```

### Other Common Issues

* **`--verify` passes but no sessions show on the dashboard:** The reporter only reports *active* sessions — make sure a Claude Code, Kimi Code, or Happy session is actually running. Also check that the relevant adapter is enabled in `~/.agentdash/config.json` (`--verify` lists enabled adapters in its PASS line).
* **Reporter not running at all:** Verify the service is loaded:
  ```bash
  # macOS
  launchctl list | grep agentdash
  # Linux
  systemctl --user status agentdash-reporter.timer
  ```
  Reload if needed (macOS): `launchctl unload ~/Library/LaunchAgents/com.agentdash.reporter.plist && launchctl load ~/Library/LaunchAgents/com.agentdash.reporter.plist`
* **Log file missing:** The installer creates `~/.agentdash/` automatically. If the directory was deleted, `--verify` now recreates it (and fails loudly if it can't); or re-run the installer.
