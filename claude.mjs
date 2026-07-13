import { execSync as nodeExecSync } from 'child_process';
import { readdirSync, existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { VERSION, resolvePath, pathName } from './utils.mjs';

// Dependency injection for testing
let execSync = nodeExecSync;
export function setExecSync(fn) { execSync = fn; }

export async function collectClaudeSessions(cfg, overrideClaudeDir = null) {
  if (cfg?.claude?.enabled === false) return [];

  const claudeDir = overrideClaudeDir || resolvePath('~/.claude');
  const events = [];
  const seenSessionIds = new Set();
  const seenPids = new Set();

  // 1. Find running Claude processes
  const activeProcesses = [];
  try {
    const pids = execSync("pgrep -f 'claude'", { encoding: 'utf-8' })
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

  // 2. Scan for session files
  const projectsDir = join(claudeDir, 'projects');
  if (existsSync(projectsDir)) {
    try {
      const projects = readdirSync(projectsDir);
      for (const projectDir of projects) {
        const projectPath = join(projectsDir, projectDir);
        if (!statSync(projectPath).isDirectory()) continue;

        const decodedCwd = projectDir.replace(/-/g, '/');
        const sessionFiles = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

        for (const file of sessionFiles) {
          const filePath = join(projectPath, file);
          const stats = statSync(filePath);

          let sessionId = file.replace(/\.jsonl$/, '');
          let lastActivity = stats.mtime;

          // Extract metadata from last JSONL line if possible
          try {
            const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
            const lastLine = lines[lines.length - 1];
            if (lastLine) {
              const data = JSON.parse(lastLine);
              if (data.sessionId) sessionId = data.sessionId;
              if (data.timestamp) lastActivity = new Date(data.timestamp);
            }
          } catch (e) { /* fallback to file stats */ }

          // Skip very old idle sessions (24h)
          const isRecentlyUpdated = (Date.now() - lastActivity.getTime()) < 24 * 60 * 60 * 1000;

          const matchingProcess = activeProcesses.find(p =>
            p.cwd === decodedCwd || p.cwd === projectDir
          );

          if (matchingProcess || isRecentlyUpdated) {
            const state = matchingProcess ? 'active' : 'idle';
            seenSessionIds.add(sessionId);
            if (matchingProcess) seenPids.add(matchingProcess.pid);

            events.push({
              agent_id: sessionId,
              status: 'running',
              issue_title: pathName(decodedCwd),
              progress_pct: 100,
              step_name: `claude · ${state}${matchingProcess ? ` · pid ${matchingProcess.pid}` : ''}`,
              metadata: {
                reporter_version: VERSION,
                source: 'claude',
                state,
                path: decodedCwd,
                last_activity: lastActivity.toISOString(),
                host_pid: matchingProcess?.pid
              }
            });
          }
        }
      }
    } catch (e) {
      console.log(`[agentdash-reporter] Claude session scan failed: ${e.message}`);
    }
  }

  // 3. Fallback for active processes not linked to a session file
  for (const proc of activeProcesses) {
    if (seenPids.has(proc.pid)) continue;

    events.push({
      agent_id: `claude-${proc.pid}`,
      status: 'running',
      issue_title: pathName(proc.cwd),
      progress_pct: 100,
      step_name: `claude · active · pid ${proc.pid}`,
      metadata: {
        reporter_version: VERSION,
        source: 'claude',
        state: 'active',
        path: proc.cwd,
        host_pid: proc.pid
      }
    });
  }

  return events;
}
