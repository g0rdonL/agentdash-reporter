import { execSync as nodeExecSync } from 'child_process';
import { readdirSync, existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { VERSION, resolvePath, pathName } from './utils.mjs';

// Dependency injection for testing
let execSync = nodeExecSync;
export function setExecSync(fn) { execSync = fn; }

// Recursively collect *.jsonl files under a directory (Codex nests sessions
// under sessions/YYYY/MM/DD/, but we walk generically rather than assuming
// a fixed depth).
function findJsonlFilesRecursive(dir) {
  const results = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stats;
    try {
      stats = statSync(fullPath);
    } catch {
      continue;
    }

    if (stats.isDirectory()) {
      results.push(...findJsonlFilesRecursive(fullPath));
    } else if (entry.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }

  return results;
}

export async function collectCodexSessions(cfg, overrideCodexDir = null) {
  if (cfg?.codex?.enabled === false) return [];

  const codexDir = overrideCodexDir || resolvePath('~/.codex');
  const events = [];
  const seenPids = new Set();

  // 1. Find running Codex processes
  const activeProcesses = [];
  try {
    const pids = execSync("pgrep -f 'codex'", { encoding: 'utf-8' })
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

  // 2. Scan for session files under ~/.codex/sessions/**/*.jsonl
  const sessionsDir = join(codexDir, 'sessions');
  if (existsSync(sessionsDir)) {
    try {
      const sessionFiles = findJsonlFilesRecursive(sessionsDir);

      for (const filePath of sessionFiles) {
        let sessionId = null;
        let sessionCwd = null;
        let lastActivity = null;

        try {
          const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
          if (!lines.length) continue;

          // First line is authoritative session_meta — id and cwd come from
          // its payload, never decoded from the file/directory name.
          try {
            const first = JSON.parse(lines[0]);
            if (first.type === 'session_meta') {
              if (first.payload?.id) sessionId = first.payload.id;
              if (first.payload?.cwd) sessionCwd = first.payload.cwd;
              if (first.payload?.timestamp) lastActivity = new Date(first.payload.timestamp);
              else if (first.timestamp) lastActivity = new Date(first.timestamp);
            }
          } catch { /* unparsable first line */ }

          // Last line's top-level timestamp drives recency/activity.
          const lastLine = lines[lines.length - 1];
          try {
            const last = JSON.parse(lastLine);
            if (last.timestamp) lastActivity = new Date(last.timestamp);
          } catch { /* fall back to whatever we have (session_meta ts or mtime) */ }
        } catch (e) { /* fallback to file stats below */ }

        if (!sessionId) {
          // Fallback: filename stem, e.g. rollout-2026-05-24T21-36-04-019e5a6a-...
          sessionId = filePath.split('/').pop().replace(/\.jsonl$/, '');
        }

        if (!lastActivity) {
          try { lastActivity = statSync(filePath).mtime; } catch { lastActivity = new Date(0); }
        }

        const resolvedCwd = sessionCwd || 'unknown';

        // Skip very old idle sessions (24h)
        const isRecentlyUpdated = (Date.now() - lastActivity.getTime()) < 24 * 60 * 60 * 1000;

        const matchingProcess = activeProcesses.find(p => p.cwd === resolvedCwd);

        if (matchingProcess || isRecentlyUpdated) {
          const state = matchingProcess ? 'active' : 'idle';
          if (matchingProcess) seenPids.add(matchingProcess.pid);

          events.push({
            agent_id: sessionId,
            status: 'running',
            issue_title: pathName(resolvedCwd),
            progress_pct: 100,
            step_name: `codex · ${state}${matchingProcess ? ` · pid ${matchingProcess.pid}` : ''}`,
            metadata: {
              reporter_version: VERSION,
              source: 'codex',
              state,
              path: resolvedCwd,
              last_activity: lastActivity.toISOString(),
              host_pid: matchingProcess?.pid
            }
          });
        }
      }
    } catch (e) {
      console.log(`[agentdash-reporter] Codex session scan failed: ${e.message}`);
    }
  }

  // 3. Fallback for active processes not linked to a session file
  for (const proc of activeProcesses) {
    if (seenPids.has(proc.pid)) continue;

    events.push({
      agent_id: `codex-${proc.pid}`,
      status: 'running',
      issue_title: pathName(proc.cwd),
      progress_pct: 100,
      step_name: `codex · active · pid ${proc.pid}`,
      metadata: {
        reporter_version: VERSION,
        source: 'codex',
        state: 'active',
        path: proc.cwd,
        host_pid: proc.pid
      }
    });
  }

  return events;
}
