import { execSync as nodeExecSync } from 'child_process';
import { existsSync } from 'fs';
import { VERSION, resolvePath, pathName } from './utils.mjs';

// Dependency injection for testing
let execSync = nodeExecSync;
export function setExecSync(fn) { execSync = fn; }

export async function collectOpenCodeSessions(cfg, overrideDbPath = null) {
  if (cfg?.opencode?.enabled === false) return [];

  const dbPath = overrideDbPath || resolvePath('~/.local/share/opencode/opencode.db');
  const events = [];
  const seenSessionIds = new Set();
  const seenPids = new Set();

  // 1. Find running OpenCode processes
  const activeProcesses = [];
  try {
    const pids = execSync("pgrep -f 'opencode'", { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);

    for (const pidStr of pids) {
      const pid = parseInt(pidStr);
      if (pid === process.pid) continue;

      let cwd = 'unknown';
      try {
        cwd = execSync(`lsof -p ${pid} 2>/dev/null | grep ' cwd ' | awk '{print $NF}'`, { encoding: 'utf-8' }).trim() || 'unknown';
      } catch {}

      activeProcesses.push({ pid, cwd });
    }
  } catch { /* no processes */ }

  // 2. Query OpenCode SQLite database
  let sessions = [];
  if (existsSync(dbPath)) {
    try {
      const query = "SELECT id, directory, time_updated, time_archived FROM session";
      // Escape path for shell execution
      const escapedDbPath = dbPath.replace(/'/g, "'\\''");
      const cmd = `sqlite3 -readonly -json '${escapedDbPath}' "${query}"`;
      const stdout = execSync(cmd, { encoding: 'utf-8' }).trim();
      if (stdout) {
        sessions = JSON.parse(stdout);
      }
    } catch (e) {
      console.log(`[agentdash-reporter] OpenCode session scan failed: ${e.message}`);
    }
  }

  // 3. Match sessions to processes and build events
  for (const session of sessions) {
    if (!session.id || !session.directory) continue;

    // Exclude archived sessions
    const isArchived = !!session.time_archived;
    if (isArchived) continue;

    const lastActivity = new Date(Number(session.time_updated));
    // Skip very old idle sessions (24h)
    const isRecentlyUpdated = (Date.now() - lastActivity.getTime()) < 24 * 60 * 60 * 1000;

    const matchingProcess = activeProcesses.find(p => p.cwd === session.directory);

    if (matchingProcess || isRecentlyUpdated) {
      const state = matchingProcess ? 'active' : 'idle';
      seenSessionIds.add(session.id);
      if (matchingProcess) seenPids.add(matchingProcess.pid);

      events.push({
        agent_id: session.id,
        status: 'running',
        issue_title: pathName(session.directory),
        progress_pct: 100,
        step_name: `opencode · ${state}${matchingProcess ? ` · pid ${matchingProcess.pid}` : ''}`,
        metadata: {
          reporter_version: VERSION,
          source: 'opencode',
          state,
          path: session.directory,
          last_activity: lastActivity.toISOString(),
          host_pid: matchingProcess?.pid
        }
      });
    }
  }

  // 4. Fallback for active processes not linked to a session
  for (const proc of activeProcesses) {
    if (seenPids.has(proc.pid)) continue;

    events.push({
      agent_id: `opencode-${proc.pid}`,
      status: 'running',
      issue_title: pathName(proc.cwd),
      progress_pct: 100,
      step_name: `opencode · active · pid ${proc.pid}`,
      metadata: {
        reporter_version: VERSION,
        source: 'opencode',
        state: 'active',
        path: proc.cwd,
        host_pid: proc.pid
      }
    });
  }

  return events;
}
