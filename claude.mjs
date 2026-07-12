import { execSync as nodeExecSync } from 'child_process';
import { readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { VERSION, loadJson, resolvePath, pathName } from './utils.mjs';

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
      for (const project of projects) {
        const sessionsDir = join(projectsDir, project, 'sessions');
        if (!existsSync(sessionsDir)) continue;

        const sessionFiles = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        for (const file of sessionFiles) {
          const filePath = join(sessionsDir, file);
          const session = loadJson(filePath);
          if (!session || !session.id) continue;

          const stats = statSync(filePath);
          const lastActivity = session.updatedAt ? new Date(session.updatedAt) : stats.mtime;

          // Skip very old idle sessions (24h)
          const isRecentlyUpdated = (Date.now() - lastActivity.getTime()) < 24 * 60 * 60 * 1000;

          const matchingProcess = activeProcesses.find(p =>
            p.cwd === session.projectPath || p.cwd.endsWith(project)
          );

          if (matchingProcess || isRecentlyUpdated) {
            const state = matchingProcess ? 'active' : 'idle';
            const sessionId = session.id;
            seenSessionIds.add(sessionId);
            if (matchingProcess) seenPids.add(matchingProcess.pid);

            events.push({
              agent_id: sessionId,
              status: 'running',
              issue_title: session.title || pathName(session.projectPath || project),
              progress_pct: 100,
              step_name: `claude · ${state}${matchingProcess ? ` · pid ${matchingProcess.pid}` : ''}`,
              metadata: {
                reporter_version: VERSION,
                source: 'claude',
                state,
                path: session.projectPath || 'unknown',
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
