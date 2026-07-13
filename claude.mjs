import { execSync as nodeExecSync } from 'child_process';
import { readdirSync, existsSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { VERSION, resolvePath, pathName } from './utils.mjs';

// Dependency injection for testing
let execSync = nodeExecSync;
export function setExecSync(fn) { execSync = fn; }

// Forward-encode a real cwd the way Claude Code names its project dirs:
// every '/' and '.' becomes '-'. Deterministic (unlike backward decoding,
// which is ambiguous for hyphenated paths).
export function encodeCwd(cwd) {
  return String(cwd).replace(/[/.]/g, '-');
}

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

        // Claude Code's dir-name encoding is LOSSY (both '/' and '-' and '.'
        // map to '-'), so backward-decoding is ambiguous for hyphenated paths
        // (e.g. -opt-gordon-trader). Instead: (a) prefer the exact `cwd` field
        // stored inside the session JSONL lines, (b) match processes by
        // encoding their real cwd FORWARD, which is deterministic.
        const naiveDecodedCwd = projectDir.replace(/-/g, '/');
        const sessionFiles = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

        for (const file of sessionFiles) {
          const filePath = join(projectPath, file);
          const stats = statSync(filePath);

          let sessionId = file.replace(/\.jsonl$/, '');
          let lastActivity = stats.mtime;
          let sessionCwd = null;

          // Extract metadata from last JSONL line if possible
          try {
            const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
            const lastLine = lines[lines.length - 1];
            if (lastLine) {
              const data = JSON.parse(lastLine);
              if (data.sessionId) sessionId = data.sessionId;
              if (data.timestamp) lastActivity = new Date(data.timestamp);
              if (data.cwd) sessionCwd = data.cwd;
            }
            // cwd may only be on earlier lines; scan backwards a bit if missing
            if (!sessionCwd) {
              for (let i = lines.length - 1; i >= 0 && i >= lines.length - 20; i--) {
                try {
                  const d = JSON.parse(lines[i]);
                  if (d.cwd) { sessionCwd = d.cwd; break; }
                } catch { /* skip unparsable line */ }
              }
            }
          } catch (e) { /* fallback to file stats */ }

          const resolvedCwd = sessionCwd || naiveDecodedCwd;

          // Skip very old idle sessions (24h)
          const isRecentlyUpdated = (Date.now() - lastActivity.getTime()) < 24 * 60 * 60 * 1000;

          const matchingProcess = activeProcesses.find(p =>
            p.cwd === resolvedCwd || encodeCwd(p.cwd) === projectDir
          );

          if (matchingProcess || isRecentlyUpdated) {
            const state = matchingProcess ? 'active' : 'idle';
            seenSessionIds.add(sessionId);
            if (matchingProcess) seenPids.add(matchingProcess.pid);

            events.push({
              agent_id: sessionId,
              status: 'running',
              issue_title: pathName(resolvedCwd),
              progress_pct: 100,
              step_name: `claude · ${state}${matchingProcess ? ` · pid ${matchingProcess.pid}` : ''}`,
              metadata: {
                reporter_version: VERSION,
                source: 'claude',
                state,
                path: resolvedCwd,
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
