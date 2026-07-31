import test from 'node:test';
import assert from 'node:assert';
import { collectOpenCodeSessions, setExecSync } from '../opencode.mjs';
import { execSync as nodeExecSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync } from 'fs';

let mockCommands = {};

// Delegate to real execSync for sqlite3, mock the rest
setExecSync((cmd, opts) => {
  if (cmd.startsWith('sqlite3 ')) {
    return nodeExecSync(cmd, opts);
  }
  for (const key of Object.keys(mockCommands)) {
    if (cmd.includes(key)) {
      const val = mockCommands[key];
      if (typeof val === 'function') return val(cmd, opts);
      return val;
    }
  }
  throw new Error(`Command not mocked in test: ${cmd}`);
});

function createTempHome() {
  const baseDir = join(tmpdir(), 'opencode-test-');
  return mkdtempSync(baseDir);
}

function createFixtureDb(dbPath, sessions) {
  // Create schema
  const schema = `
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT,
      directory TEXT,
      path TEXT,
      title TEXT,
      version TEXT,
      share_url TEXT,
      cost REAL,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_reasoning INTEGER,
      time_updated INTEGER,
      time_compacting INTEGER,
      time_archived INTEGER
    );
  `;
  nodeExecSync(`sqlite3 "${dbPath}" "${schema}"`);

  for (const session of sessions) {
    const columns = Object.keys(session).join(', ');
    const values = Object.values(session).map(v => {
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
      return v;
    }).join(', ');

    nodeExecSync(`sqlite3 "${dbPath}" "INSERT INTO session (${columns}) VALUES (${values});"`);
  }
}

test('collectOpenCodeSessions - disabled adapter returns []', async () => {
  const events = await collectOpenCodeSessions({ opencode: { enabled: false } });
  assert.deepStrictEqual(events, []);
});

test('collectOpenCodeSessions - active, idle, stale, and archived session behavior', async () => {
  const tempHome = createTempHome();
  const dbPath = join(tempHome, 'opencode.db');
  const now = Date.now();

  const sessions = [
    // 1. Active session (has matching process and recent)
    {
      id: 'ses_active_123',
      directory: '/Users/gordon/dev/active-project',
      time_updated: now - 5000, // 5s ago
      time_archived: null
    },
    // 2. Idle session (no matching process but recent)
    {
      id: 'ses_idle_456',
      directory: '/Users/gordon/dev/idle-project',
      time_updated: now - 60 * 60 * 1000, // 1h ago
      time_archived: null
    },
    // 3. Stale session (no matching process and older than 24h)
    {
      id: 'ses_stale_789',
      directory: '/Users/gordon/dev/stale-project',
      time_updated: now - 25 * 60 * 60 * 1000, // 25h ago
      time_archived: null
    },
    // 4. Archived session (recent time_updated but time_archived is set)
    {
      id: 'ses_archived_abc',
      directory: '/Users/gordon/dev/archived-project',
      time_updated: now - 1000,
      time_archived: now - 500
    }
  ];

  createFixtureDb(dbPath, sessions);

  // Set process mocks
  // Process with pid 10001 is running opencode under '/Users/gordon/dev/active-project'
  mockCommands = {
    "pgrep -f 'opencode'": "10001\n",
    "lsof -p 10001": "/Users/gordon/dev/active-project\n"
  };

  try {
    const events = await collectOpenCodeSessions({ opencode: { enabled: true } }, dbPath);

    // Active and Idle sessions should be returned. Stale and Archived should be excluded.
    assert.strictEqual(events.length, 2);

    const activeEv = events.find(e => e.agent_id === 'ses_active_123');
    assert.ok(activeEv, 'Active session should be present');
    assert.strictEqual(activeEv.metadata.state, 'active');
    assert.strictEqual(activeEv.metadata.host_pid, 10001);
    assert.strictEqual(activeEv.issue_title, 'active-project');
    assert.strictEqual(activeEv.step_name, 'opencode · active · pid 10001');

    const idleEv = events.find(e => e.agent_id === 'ses_idle_456');
    assert.ok(idleEv, 'Idle session should be present');
    assert.strictEqual(idleEv.metadata.state, 'idle');
    assert.strictEqual(idleEv.metadata.host_pid, undefined);
    assert.strictEqual(idleEv.issue_title, 'idle-project');
    assert.strictEqual(idleEv.step_name, 'opencode · idle');

    const staleEv = events.find(e => e.agent_id === 'ses_stale_789');
    assert.ok(!staleEv, 'Stale session should be excluded');

    const archivedEv = events.find(e => e.agent_id === 'ses_archived_abc');
    assert.ok(!archivedEv, 'Archived session should be excluded');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
    mockCommands = {};
  }
});

test('collectOpenCodeSessions - fallback for active processes not in DB', async () => {
  const tempHome = createTempHome();
  const dbPath = join(tempHome, 'opencode.db');
  const now = Date.now();

  const sessions = [
    {
      id: 'ses_known',
      directory: '/Users/gordon/dev/known-project',
      time_updated: now - 5000,
      time_archived: null
    }
  ];

  createFixtureDb(dbPath, sessions);

  // We have two running processes:
  // - PID 20001 matching '/Users/gordon/dev/known-project'
  // - PID 20002 matching '/Users/gordon/dev/unknown-project'
  mockCommands = {
    "pgrep -f 'opencode'": "20001\n20002\n",
    "lsof -p 20001": "/Users/gordon/dev/known-project\n",
    "lsof -p 20002": "/Users/gordon/dev/unknown-project\n"
  };

  try {
    const events = await collectOpenCodeSessions({ opencode: { enabled: true } }, dbPath);

    // We expect 2 events: one from DB matched process, one fallback process-only event
    assert.strictEqual(events.length, 2);

    const knownEv = events.find(e => e.agent_id === 'ses_known');
    assert.ok(knownEv);
    assert.strictEqual(knownEv.metadata.state, 'active');
    assert.strictEqual(knownEv.metadata.host_pid, 20001);

    const fallbackEv = events.find(e => e.agent_id === 'opencode-20002');
    assert.ok(fallbackEv);
    assert.strictEqual(fallbackEv.metadata.state, 'active');
    assert.strictEqual(fallbackEv.metadata.host_pid, 20002);
    assert.strictEqual(fallbackEv.metadata.path, '/Users/gordon/dev/unknown-project');
    assert.strictEqual(fallbackEv.issue_title, 'unknown-project');
    assert.strictEqual(fallbackEv.step_name, 'opencode · active · pid 20002');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
    mockCommands = {};
  }
});

test('cleanup - restore execSync', () => {
  setExecSync(nodeExecSync);
});
