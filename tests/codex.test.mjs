import test from 'node:test';
import assert from 'node:assert';
import { collectCodexSessions, setExecSync } from '../codex.mjs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';

// Default mock to prevent executing real host commands (like pgrep/lsof) during testing
const defaultMock = (cmd) => {
  if (cmd.includes("pgrep -f 'codex'")) {
    return '';
  }
  throw new Error(`Command not mocked in test: ${cmd}`);
};

setExecSync(defaultMock);

function createTempCodexHome() {
  const baseDir = join(tmpdir(), 'codex-test-');
  return mkdtempSync(baseDir);
}

// Fixtures follow the verified real-world line shapes:
//   line 1: {"type": "session_meta", "payload": {...}, "timestamp": ...}
//   later:  {"type": "event_msg" | "response_item", "payload": {...}, "timestamp": ...}
// Timestamps are generated at call time (fresh, not hardcoded) so recency-window
// filtering doesn't silently rot the fixtures.
function sessionMetaLine({ id, cwd, timestamp, originator = 'happy-codex', source = 'vscode' }) {
  return JSON.stringify({
    type: 'session_meta',
    payload: {
      id,
      timestamp,
      cwd,
      originator,
      cli_version: '0.1.0',
      source,
      model_provider: 'openai',
      git: {},
      base_instructions: 'You are Codex.'
    },
    timestamp
  });
}

function eventMsgLine({ timestamp, turnId = 'turn-1' }) {
  return JSON.stringify({
    type: 'event_msg',
    payload: {
      turn_id: turnId,
      started_at: timestamp,
      model_context_window: 128000,
      collaboration_mode_kind: 'default',
      type: 'turn_started'
    },
    timestamp
  });
}

function responseItemLine({ timestamp, role = 'assistant', content = 'ok' }) {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      role,
      content,
      type: 'message'
    },
    timestamp
  });
}

// Mirrors the verified layout: ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl
function writeSessionFile(codexHome, { id, cwd, startTimestamp, lastTimestamp, dateParts }) {
  const [year, month, day] = dateParts;
  const dir = join(codexHome, 'sessions', year, month, day);
  mkdirSync(dir, { recursive: true });

  const fileSafeStart = startTimestamp.replace(/:/g, '-');
  const filePath = join(dir, `rollout-${fileSafeStart}-${id}.jsonl`);

  const lines = [
    sessionMetaLine({ id, cwd, timestamp: startTimestamp }),
    eventMsgLine({ timestamp: startTimestamp }),
    responseItemLine({ timestamp: lastTimestamp })
  ];

  writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

function isoPartsAgo(msAgo) {
  const d = new Date(Date.now() - msAgo);
  return {
    iso: d.toISOString(),
    parts: [
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, '0'),
      String(d.getUTCDate()).padStart(2, '0')
    ]
  };
}

test('collectCodexSessions - disabled adapter returns []', async () => {
  const events = await collectCodexSessions({ codex: { enabled: false } });
  assert.deepStrictEqual(events, []);
});

test('collectCodexSessions - active, idle, and stale session behavior', async () => {
  const tempHome = createTempCodexHome();

  try {
    // 1. Active session — recent + matching process
    const activeStart = isoPartsAgo(60000); // 1 min ago
    const activeLast = isoPartsAgo(5000);   // 5s ago
    writeSessionFile(tempHome, {
      id: 'codex-active-uuid',
      cwd: '/Users/gordon/dev/active-project',
      startTimestamp: activeStart.iso,
      lastTimestamp: activeLast.iso,
      dateParts: activeStart.parts
    });

    // 2. Idle session — recent (within 24h) but no matching process
    const idleStart = isoPartsAgo(3 * 60 * 60 * 1000); // 3h ago
    const idleLast = isoPartsAgo(60 * 60 * 1000);       // 1h ago
    writeSessionFile(tempHome, {
      id: 'codex-idle-uuid',
      cwd: '/Users/gordon/dev/idle-project',
      startTimestamp: idleStart.iso,
      lastTimestamp: idleLast.iso,
      dateParts: idleStart.parts
    });

    // 3. Stale session — last activity > 24h ago, no matching process
    const staleStart = isoPartsAgo(30 * 60 * 60 * 1000); // 30h ago
    const staleLast = isoPartsAgo(25 * 60 * 60 * 1000);  // 25h ago
    writeSessionFile(tempHome, {
      id: 'codex-stale-uuid',
      cwd: '/Users/gordon/dev/stale-project',
      startTimestamp: staleStart.iso,
      lastTimestamp: staleLast.iso,
      dateParts: staleStart.parts
    });

    setExecSync((cmd) => {
      if (cmd.includes("pgrep -f 'codex'")) return '30001\n';
      if (cmd.includes('lsof -p 30001')) return '/Users/gordon/dev/active-project\n';
      throw new Error(`Command not mocked in test: ${cmd}`);
    });

    const events = await collectCodexSessions({ codex: { enabled: true } }, tempHome);

    assert.strictEqual(events.length, 2, 'active + idle should be reported, stale excluded');

    const activeEv = events.find(e => e.agent_id === 'codex-active-uuid');
    assert.ok(activeEv, 'Active session should be present');
    assert.strictEqual(activeEv.metadata.state, 'active');
    assert.strictEqual(activeEv.metadata.host_pid, 30001);
    assert.strictEqual(activeEv.metadata.path, '/Users/gordon/dev/active-project');
    assert.strictEqual(activeEv.metadata.source, 'codex');
    assert.strictEqual(activeEv.issue_title, 'active-project');
    assert.strictEqual(activeEv.step_name, 'codex · active · pid 30001');
    assert.strictEqual(activeEv.metadata.last_activity, activeLast.iso);

    const idleEv = events.find(e => e.agent_id === 'codex-idle-uuid');
    assert.ok(idleEv, 'Idle session should be present');
    assert.strictEqual(idleEv.metadata.state, 'idle');
    assert.strictEqual(idleEv.metadata.host_pid, undefined);
    assert.strictEqual(idleEv.issue_title, 'idle-project');
    assert.strictEqual(idleEv.step_name, 'codex · idle');

    const staleEv = events.find(e => e.agent_id === 'codex-stale-uuid');
    assert.ok(!staleEv, 'Stale session should be excluded');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
    setExecSync(defaultMock);
  }
});

test('collectCodexSessions - session id and cwd come from session_meta payload, not filename/dirname', async () => {
  const tempHome = createTempCodexHome();

  try {
    const start = isoPartsAgo(20000);
    const last = isoPartsAgo(1000);

    // cwd deliberately does NOT match any decodable form of the directory
    // structure — proves cwd is read from payload.cwd, never derived from
    // the file/directory names.
    writeSessionFile(tempHome, {
      id: '019e5a6a-abcd-uuid',
      cwd: '/opt/some-hyphenated/project.path',
      startTimestamp: start.iso,
      lastTimestamp: last.iso,
      dateParts: start.parts
    });

    const events = await collectCodexSessions({ codex: { enabled: true } }, tempHome);
    assert.strictEqual(events.length, 1);

    const ev = events[0];
    assert.strictEqual(ev.agent_id, '019e5a6a-abcd-uuid');
    assert.strictEqual(ev.metadata.path, '/opt/some-hyphenated/project.path');
    assert.strictEqual(ev.issue_title, 'project.path');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('collectCodexSessions - falls back to filename stem when session_meta is missing/unparsable', async () => {
  const tempHome = createTempCodexHome();

  try {
    const start = isoPartsAgo(15000);
    const last = isoPartsAgo(2000);
    const dir = join(tempHome, 'sessions', start.parts[0], start.parts[1], start.parts[2]);
    mkdirSync(dir, { recursive: true });

    const filePath = join(dir, 'rollout-broken-session.jsonl');
    // No session_meta line at all — just a response_item with a timestamp.
    writeFileSync(filePath, [
      responseItemLine({ timestamp: last.iso })
    ].join('\n') + '\n');

    const events = await collectCodexSessions({ codex: { enabled: true } }, tempHome);
    assert.strictEqual(events.length, 1);

    const ev = events[0];
    assert.strictEqual(ev.agent_id, 'rollout-broken-session');
    assert.strictEqual(ev.metadata.path, 'unknown');
    assert.strictEqual(ev.issue_title, 'unknown');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('collectCodexSessions - fallback for active processes not in any session file', async () => {
  const tempHome = createTempCodexHome();

  try {
    const start = isoPartsAgo(10000);
    const last = isoPartsAgo(3000);
    writeSessionFile(tempHome, {
      id: 'codex-known',
      cwd: '/Users/gordon/dev/known-project',
      startTimestamp: start.iso,
      lastTimestamp: last.iso,
      dateParts: start.parts
    });

    setExecSync((cmd) => {
      if (cmd.includes("pgrep -f 'codex'")) return '40001\n40002\n';
      if (cmd.includes('lsof -p 40001')) return '/Users/gordon/dev/known-project\n';
      if (cmd.includes('lsof -p 40002')) return '/Users/gordon/dev/unknown-project\n';
      throw new Error(`Command not mocked in test: ${cmd}`);
    });

    const events = await collectCodexSessions({ codex: { enabled: true } }, tempHome);
    assert.strictEqual(events.length, 2);

    const knownEv = events.find(e => e.agent_id === 'codex-known');
    assert.ok(knownEv);
    assert.strictEqual(knownEv.metadata.state, 'active');
    assert.strictEqual(knownEv.metadata.host_pid, 40001);

    const fallbackEv = events.find(e => e.agent_id === 'codex-40002');
    assert.ok(fallbackEv);
    assert.strictEqual(fallbackEv.metadata.state, 'active');
    assert.strictEqual(fallbackEv.metadata.host_pid, 40002);
    assert.strictEqual(fallbackEv.metadata.path, '/Users/gordon/dev/unknown-project');
    assert.strictEqual(fallbackEv.issue_title, 'unknown-project');
    assert.strictEqual(fallbackEv.step_name, 'codex · active · pid 40002');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
    setExecSync(defaultMock);
  }
});

test('collectCodexSessions - recursive discovery across nested date directories', async () => {
  const tempHome = createTempCodexHome();

  try {
    const a = isoPartsAgo(50000);
    const b = isoPartsAgo(40000);
    writeSessionFile(tempHome, {
      id: 'codex-day-a',
      cwd: '/Users/gordon/dev/project-a',
      startTimestamp: a.iso,
      lastTimestamp: a.iso,
      dateParts: a.parts
    });
    writeSessionFile(tempHome, {
      id: 'codex-day-b',
      cwd: '/Users/gordon/dev/project-b',
      startTimestamp: b.iso,
      lastTimestamp: b.iso,
      dateParts: b.parts
    });

    const events = await collectCodexSessions({ codex: { enabled: true } }, tempHome);
    const ids = events.map(e => e.agent_id).sort();
    assert.deepStrictEqual(ids, ['codex-day-a', 'codex-day-b']);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('cleanup - restore execSync', () => {
  setExecSync(defaultMock);
});
