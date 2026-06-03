#!/usr/bin/env node
// AgentDash Reporter — watches local AI coding sessions and reports status
// Runs every 60s via launchd. No dependencies beyond Node.js built-ins.

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { homedir } from 'os';
import { join } from 'path';

const VERSION = '1.0.0';
const CONFIG_PATH = join(homedir(), '.agentdash', 'config.json');

// ── Config ──

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`[agentdash-reporter] No config found at ${CONFIG_PATH}`);
    console.error('Run the installer or create the config manually:');
    console.error('  https://agentdash.ink/docs/reporter');
    process.exit(1);
  }
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    if (!cfg.api_key || !cfg.api_key.startsWith('ad_live_')) {
      console.error('[agentdash-reporter] Invalid or missing api_key in config.');
      console.error('Get your API key at https://agentdash.ink/settings/api-keys');
      process.exit(1);
    }
    return {
      api_key: cfg.api_key,
      api_url: (cfg.api_url || 'https://agentdash.ink').replace(/\/$/, ''),
      happy: { enabled: cfg.happy?.enabled !== false, ...cfg.happy },
      kimi:  { enabled: cfg.kimi?.enabled  === true,  ...cfg.kimi  },
    };
  } catch (e) {
    console.error(`[agentdash-reporter] Failed to parse config: ${e.message}`);
    process.exit(1);
  }
}

// ── Helpers ──

function loadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function resolvePath(p) {
  return p ? p.replace(/^~/, homedir()) : null;
}

function httpPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = mod({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function pathName(p) {
  if (!p || p === 'unknown') return 'unknown';
  const parts = p.split('/').filter(Boolean);
  const name = parts[parts.length - 1] || p;
  if (['tmp', 'dev', 'worktree', 'worktrees'].includes(name) && parts.length >= 2) {
    return parts.slice(-2).join('/');
  }
  return name;
}

// ── Happy sessions ──

async function collectHappySessions(cfg) {
  const statePath = resolvePath(cfg.happy.daemon_state_path || '~/.happy/daemon.state.json');
  const titlesPath = resolvePath(cfg.happy.session_titles_path || '~/.happy/session-titles.json');

  const daemonState = loadJson(statePath);
  if (!daemonState?.lastHeartbeat) return [];

  const age = Date.now() - new Date(daemonState.lastHeartbeat).getTime();
  if (age > 120000) {
    console.log('[agentdash-reporter] Happy daemon heartbeat stale — skipping');
    return [];
  }

  const port = daemonState.httpPort;
  if (!port) return [];

  let children = [];
  try {
    const resp = await httpPost(`http://127.0.0.1:${port}/list`, {});
    children = resp.body?.children || [];
  } catch (e) {
    console.log(`[agentdash-reporter] Happy daemon /list failed: ${e.message}`);
    return [];
  }

  const sessionTitles = loadJson(titlesPath) || {};
  const events = [];

  for (const child of children) {
    const { happySessionId: sessionId, pid } = child;
    if (!sessionId || !pid) continue;

    try {
      execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
    } catch {
      continue; // process dead
    }

    let cwd = 'unknown';
    try {
      cwd = execSync(`lsof -p ${pid} 2>/dev/null | grep ' cwd ' | awk '{print $NF}'`, { encoding: 'utf-8' }).trim() || 'unknown';
    } catch {}

    let flavor = 'claude';
    try {
      const cmd = execSync(`ps -p ${pid} -o args= 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (cmd.includes('kimi')) flavor = 'kimi';
      else if (cmd.includes('gemini')) flavor = 'gemini';
      else if (cmd.includes('codex')) flavor = 'codex';
    } catch {}

    const title = sessionTitles[sessionId]?.title || pathName(cwd);

    events.push({
      agent_id: sessionId,
      status: 'running',
      issue_title: title,
      progress_pct: 100,
      step_name: `${flavor} · pid ${pid}`,
      metadata: { reporter_version: VERSION, source: 'happy', flavor, path: cwd, host_pid: pid },
    });
  }

  return events;
}

// ── Kimi sessions ──

async function collectKimiSessions() {
  let pids = [];
  try {
    pids = execSync("pgrep -f 'Kimi Code'", { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
  } catch { return []; }

  const events = [];
  for (const pid of pids) {
    let cwd = 'unknown';
    try {
      cwd = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`, { encoding: 'utf-8' }).trim();
    } catch {}

    events.push({
      agent_id: `kimi-${pid}`,
      status: 'running',
      issue_title: pathName(cwd),
      progress_pct: 100,
      step_name: `kimi · pid ${pid}`,
      metadata: { reporter_version: VERSION, source: 'kimi', path: cwd, host_pid: parseInt(pid) },
    });
  }
  return events;
}

// ── Send to AgentDash ──

async function sendBatch(cfg, events) {
  const url = `${cfg.api_url}/api/v1/emitter/status/batch`;
  const headers = { Authorization: `Bearer ${cfg.api_key}` };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await httpPost(url, events, headers);
      if (resp.status === 200) return resp.body;
      if (resp.status === 401) {
        console.error('[agentdash-reporter] API key rejected — check your config');
        process.exit(1);
      }
      throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, attempt * 500));
    }
  }
}

// ── Main ──

async function main() {
  const cfg = loadConfig();
  const started = Date.now();

  const events = [];
  if (cfg.happy.enabled) events.push(...await collectHappySessions(cfg));
  if (cfg.kimi.enabled)  events.push(...await collectKimiSessions());

  if (!events.length) {
    console.log('[agentdash-reporter] No active sessions found');
    return;
  }

  const result = await sendBatch(cfg, events);
  const ms = Date.now() - started;
  console.log(`[agentdash-reporter] Sent ${result?.count ?? events.length} events in ${ms}ms`);
}

main().catch(e => {
  console.error('[agentdash-reporter] Fatal:', e.message);
  process.exit(1);
});
