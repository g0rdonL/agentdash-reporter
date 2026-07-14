import test from 'node:test';
import assert from 'node:assert';
import { collectClaudeSessions, setExecSync, encodeCwd } from '../claude.mjs';
import { execSync as nodeExecSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'fs';

// Default mock to prevent executing real host commands (like pgrep/lsof) during testing
const defaultMock = (cmd) => {
  if (cmd.includes("pgrep -f 'claude'")) {
    return '';
  }
  throw new Error(`Command not mocked in test: ${cmd}`);
};

setExecSync(defaultMock);

// Helper function to create a unique temporary directory for each run
function createTempClaudeHome() {
  const baseDir = join(tmpdir(), 'claude-test-');
  return mkdtempSync(baseDir);
}

test('encodeCwd - forward encoding is deterministic for hyphenated paths', () => {
  // Verified against real ~/.claude/projects dir names
  assert.strictEqual(encodeCwd('/Users/gordon/dev/foo'), '-Users-gordon-dev-foo');
  assert.strictEqual(encodeCwd('/opt/gordon-trader'), '-opt-gordon-trader');
});

test('collectClaudeSessions - discovery of multiple sessions across projects', async (t) => {
  const tempHome = createTempClaudeHome();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  try {
    // Project 1
    const p1Dir = join(tempHome, 'projects', '-Users-gordon-dev-foo');
    mkdirSync(p1Dir, { recursive: true });
    writeFileSync(join(p1Dir, 'session-1.jsonl'), [
      JSON.stringify({ sessionId: 'session-1', timestamp: iso(5000), message: 'foo' })
    ].join('\n') + '\n');

    // Project 2
    const p2Dir = join(tempHome, 'projects', '-opt-gordon-trader');
    mkdirSync(p2Dir, { recursive: true });
    writeFileSync(join(p2Dir, 'session-2.jsonl'), [
      JSON.stringify({ sessionId: 'session-2', timestamp: iso(10000), cwd: '/opt/gordon-trader', message: 'bar' })
    ].join('\n') + '\n');

    const events = await collectClaudeSessions({ claude: { enabled: true } }, tempHome);
    assert.strictEqual(events.length, 2);

    const ev1 = events.find(e => e.agent_id === 'session-1');
    assert.ok(ev1);
    assert.strictEqual(ev1.metadata.path, '/Users/gordon/dev/foo');

    const ev2 = events.find(e => e.agent_id === 'session-2');
    assert.ok(ev2);
    assert.strictEqual(ev2.metadata.path, '/opt/gordon-trader');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('collectClaudeSessions - session ID from filename stem with sessionId-field fallback', async (t) => {
  const tempHome = createTempClaudeHome();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  try {
    const pDir = join(tempHome, 'projects', '-Users-gordon-dev-foo');
    mkdirSync(pDir, { recursive: true });

    // File with sessionId field matching or overriding (field priority)
    writeFileSync(join(pDir, 'file-abc.jsonl'), [
      JSON.stringify({ sessionId: 'session-from-field', timestamp: iso(5000) })
    ].join('\n') + '\n');

    // File without sessionId field (filename stem fallback)
    writeFileSync(join(pDir, 'file-xyz.jsonl'), [
      JSON.stringify({ timestamp: iso(10000) })
    ].join('\n') + '\n');

    const events = await collectClaudeSessions({ claude: { enabled: true } }, tempHome);
    assert.strictEqual(events.length, 2);

    const ev1 = events.find(e => e.agent_id === 'session-from-field');
    assert.ok(ev1, 'Should fall back/resolve to sessionId field when present');

    const ev2 = events.find(e => e.agent_id === 'file-xyz');
    assert.ok(ev2, 'Should fall back to filename stem when sessionId field is absent');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('collectClaudeSessions - last-activity from mtime with timestamp fallback', async (t) => {
  const tempHome = createTempClaudeHome();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  try {
    const pDir = join(tempHome, 'projects', '-Users-gordon-dev-foo');
    mkdirSync(pDir, { recursive: true });

    // 1. With timestamp field inside JSONL
    const jsonlTime = iso(10 * 60 * 1000); // 10 minutes ago
    writeFileSync(join(pDir, 'session-time-field.jsonl'), [
      JSON.stringify({ sessionId: 'field-time', timestamp: jsonlTime })
    ].join('\n') + '\n');
    // Modify mtime to be different (e.g., 20 mins ago) to prove timestamp field takes priority
    const file1 = join(pDir, 'session-time-field.jsonl');
    const mtime1 = new Date(now - 20 * 60 * 1000);
    utimesSync(file1, mtime1, mtime1);

    // 2. Without timestamp field inside JSONL (should fall back to file mtime)
    writeFileSync(join(pDir, 'session-mtime-fallback.jsonl'), [
      JSON.stringify({ sessionId: 'fallback-time' })
    ].join('\n') + '\n');
    const file2 = join(pDir, 'session-mtime-fallback.jsonl');
    const mtime2 = new Date(now - 5 * 60 * 1000); // 5 minutes ago
    utimesSync(file2, mtime2, mtime2);

    const events = await collectClaudeSessions({ claude: { enabled: true } }, tempHome);

    const ev1 = events.find(e => e.agent_id === 'field-time');
    assert.ok(ev1);
    assert.strictEqual(ev1.metadata.last_activity, new Date(jsonlTime).toISOString());

    const ev2 = events.find(e => e.agent_id === 'fallback-time');
    assert.ok(ev2);
    assert.strictEqual(ev2.metadata.last_activity, mtime2.toISOString());
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('collectClaudeSessions - cwd-field resolution scanning backwards', async (t) => {
  const tempHome = createTempClaudeHome();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  try {
    const pDir = join(tempHome, 'projects', '-Users-gordon-dev-foo');
    mkdirSync(pDir, { recursive: true });

    // File with CWD field specified on an earlier line, but not the last line
    writeFileSync(join(pDir, 'session-cwd-backwards.jsonl'), [
      JSON.stringify({ sessionId: 'backwards-cwd', timestamp: iso(30000), cwd: '/exact/real/path' }),
      JSON.stringify({ sessionId: 'backwards-cwd', timestamp: iso(20000), message: 'middle message' }),
      JSON.stringify({ sessionId: 'backwards-cwd', timestamp: iso(10000), message: 'final message' })
    ].join('\n') + '\n');

    const events = await collectClaudeSessions({ claude: { enabled: true } }, tempHome);
    const ev = events.find(e => e.agent_id === 'backwards-cwd');
    assert.ok(ev);
    assert.strictEqual(ev.metadata.path, '/exact/real/path');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('collectClaudeSessions - recency filtering', async (t) => {
  const tempHome = createTempClaudeHome();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  try {
    // Project 1: No active process matching it
    const pDir1 = join(tempHome, 'projects', '-Users-gordon-dev-bar');
    mkdirSync(pDir1, { recursive: true });

    // Recently updated idle session (within 24 hours) - should keep
    writeFileSync(join(pDir1, 'recent-idle.jsonl'), [
      JSON.stringify({ sessionId: 'recent-idle', timestamp: iso(12 * 60 * 60 * 1000) }) // 12 hours ago
    ].join('\n') + '\n');

    // Old idle session (older than 24 hours) - should skip
    writeFileSync(join(pDir1, 'old-idle.jsonl'), [
      JSON.stringify({ sessionId: 'old-idle', timestamp: iso(25 * 60 * 60 * 1000) }) // 25 hours ago
    ].join('\n') + '\n');

    // Project 2: Has active process matching it
    const pDir2 = join(tempHome, 'projects', '-Users-gordon-dev-foo');
    mkdirSync(pDir2, { recursive: true });

    // Old session but matched to a running process - should keep
    writeFileSync(join(pDir2, 'old-active.jsonl'), [
      JSON.stringify({ sessionId: 'old-active', timestamp: iso(30 * 60 * 60 * 1000) }) // 30 hours ago
    ].join('\n') + '\n');

    // Mock active process matching 'old-active' project directory
    setExecSync((cmd) => {
      if (cmd.includes('pgrep -f')) return '9999\n';
      if (cmd.includes('lsof -p 9999')) return '/Users/gordon/dev/foo\n';
      return '';
    });

    const events = await collectClaudeSessions({ claude: { enabled: true } }, tempHome);

    const hasRecentIdle = events.some(e => e.agent_id === 'recent-idle');
    const hasOldIdle = events.some(e => e.agent_id === 'old-idle');
    const hasOldActive = events.some(e => e.agent_id === 'old-active');

    assert.strictEqual(hasRecentIdle, true, 'Should retain recently updated idle sessions');
    assert.strictEqual(hasOldIdle, false, 'Should filter out old idle sessions (>24h)');
    assert.strictEqual(hasOldActive, true, 'Should retain old sessions if they are still active');
  } finally {
    setExecSync(defaultMock);
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('collectClaudeSessions - hyphenated-path regression fixture', async (t) => {
  const tempHome = createTempClaudeHome();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  try {
    const pDir = join(tempHome, 'projects', '-opt-gordon-trader');
    mkdirSync(pDir, { recursive: true });

    // Write session specifying the hyphenated cwd field `/opt/gordon-trader`
    writeFileSync(join(pDir, 'session-hyph.jsonl'), [
      JSON.stringify({ sessionId: 'session-hyph', timestamp: iso(10000), cwd: '/opt/gordon-trader' })
    ].join('\n') + '\n');

    const events = await collectClaudeSessions({ claude: { enabled: true } }, tempHome);
    const ev = events.find(e => e.agent_id === 'session-hyph');
    assert.ok(ev);
    // Correctly reports /opt/gordon-trader, not /opt/gordon/trader
    assert.strictEqual(ev.metadata.path, '/opt/gordon-trader');
    assert.strictEqual(ev.issue_title, 'gordon-trader');
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('collectClaudeSessions - metadata contains metadata only, absolutely no message/content fields', async (t) => {
  const tempHome = createTempClaudeHome();
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  try {
    const pDir = join(tempHome, 'projects', '-Users-gordon-dev-foo');
    mkdirSync(pDir, { recursive: true });

    writeFileSync(join(pDir, 'privacy.jsonl'), [
      JSON.stringify({
        sessionId: 'privacy-test',
        timestamp: iso(5000),
        message: 'This is highly secret conversational message text',
        content: 'This is super secret file contents'
      })
    ].join('\n') + '\n');

    const events = await collectClaudeSessions({ claude: { enabled: true } }, tempHome);
    assert.strictEqual(events.length, 1);
    const ev = events[0];

    // Ensure no message or content properties are on the event or its metadata
    assert.strictEqual(ev.message, undefined);
    assert.strictEqual(ev.content, undefined);
    assert.strictEqual(ev.metadata.message, undefined);
    assert.strictEqual(ev.metadata.content, undefined);

    // Deep inspect the JSON serialized version to verify those strings don't leak anywhere
    const serialized = JSON.stringify(events);
    assert.strictEqual(serialized.includes('highly secret'), false);
    assert.strictEqual(serialized.includes('super secret'), false);
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('cleanup - restore execSync', () => {
  setExecSync(nodeExecSync);
});
