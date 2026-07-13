import test from 'node:test';
import assert from 'node:assert';
import { collectClaudeSessions, setExecSync, encodeCwd } from '../claude.mjs';
import { execSync as nodeExecSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, 'fixtures', 'claude');

// Fixtures are (re)generated with fresh timestamps at run time — static
// timestamps age past the 24h recency window and silently break the
// idle-session tests.
function writeFixtures() {
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();

  const fooDir = join(fixtureDir, 'projects', '-Users-gordon-dev-foo');
  mkdirSync(fooDir, { recursive: true });
  writeFileSync(join(fooDir, 'session-123.jsonl'), [
    JSON.stringify({ sessionId: 'session-123', timestamp: iso(60 * 60 * 1000), message: 'hello' }),
    JSON.stringify({ sessionId: 'session-123', timestamp: iso(5 * 60 * 1000), message: 'world' }),
  ].join('\n') + '\n');

  // Hyphenated real path — regression for the dash-collision bug where
  // naive decoding turned /opt/gordon-trader into /opt/gordon/trader.
  const hyphDir = join(fixtureDir, 'projects', '-opt-gordon-trader');
  mkdirSync(hyphDir, { recursive: true });
  writeFileSync(join(hyphDir, 'session-hyph.jsonl'), [
    JSON.stringify({ sessionId: 'session-hyph', timestamp: iso(30 * 60 * 1000), cwd: '/opt/gordon-trader', message: 'secret-alpha' }),
    JSON.stringify({ sessionId: 'session-hyph', timestamp: iso(2 * 60 * 1000), cwd: '/opt/gordon-trader', message: 'secret-beta' }),
  ].join('\n') + '\n');
}

writeFixtures();

test('encodeCwd - forward encoding is deterministic for hyphenated paths', () => {
  // Both verified against real ~/.claude/projects dir names on macmini1.
  assert.strictEqual(encodeCwd('/Users/gordon/dev/foo'), '-Users-gordon-dev-foo');
  assert.strictEqual(encodeCwd('/opt/gordon-trader'), '-opt-gordon-trader');
});

test('collectClaudeSessions - detects active session from process and file', async (t) => {
  setExecSync((cmd) => {
    if (cmd.includes('pgrep -f')) return '1001\n';
    if (cmd.includes('lsof -p 1001')) return '/Users/gordon/dev/foo\n';
    return '';
  });

  try {
    const events = await collectClaudeSessions({ claude: { enabled: true } }, fixtureDir);

    const ev = events.find(e => e.agent_id === 'session-123');
    assert.ok(ev, 'session-123 not found');
    assert.strictEqual(ev.metadata.state, 'active');
    assert.strictEqual(ev.metadata.host_pid, 1001);
    assert.strictEqual(ev.metadata.path, '/Users/gordon/dev/foo');
    assert.strictEqual(ev.issue_title, 'foo');
    assert.ok(ev.metadata.last_activity);

    // Privacy check
    assert.strictEqual(ev.metadata.message, undefined);
    assert.strictEqual(JSON.stringify(events).includes('hello'), false);
    assert.strictEqual(JSON.stringify(events).includes('world'), false);
  } finally {
    setExecSync(nodeExecSync);
  }
});

test('collectClaudeSessions - hyphenated cwd resolves from JSONL cwd field and matches process', async (t) => {
  setExecSync((cmd) => {
    if (cmd.includes('pgrep -f')) return '2001\n';
    if (cmd.includes('lsof -p 2001')) return '/opt/gordon-trader\n';
    return '';
  });

  try {
    const events = await collectClaudeSessions({ claude: { enabled: true } }, fixtureDir);

    const ev = events.find(e => e.agent_id === 'session-hyph');
    assert.ok(ev, 'session-hyph not found');
    // The dash-collision bug produced /opt/gordon/trader here.
    assert.strictEqual(ev.metadata.path, '/opt/gordon-trader');
    assert.strictEqual(ev.metadata.state, 'active');
    assert.strictEqual(ev.metadata.host_pid, 2001);
    assert.strictEqual(ev.issue_title, 'gordon-trader');

    // Privacy check
    assert.strictEqual(JSON.stringify(events).includes('secret-alpha'), false);
    assert.strictEqual(JSON.stringify(events).includes('secret-beta'), false);
  } finally {
    setExecSync(nodeExecSync);
  }
});

test('collectClaudeSessions - detects idle session from file only', async (t) => {
  setExecSync((cmd) => {
    throw new Error('pgrep failed');
  });

  try {
    const events = await collectClaudeSessions({ claude: { enabled: true } }, fixtureDir);

    const ev = events.find(e => e.agent_id === 'session-123');
    assert.ok(ev, 'session-123 not found');
    assert.strictEqual(ev.metadata.state, 'idle');
    assert.strictEqual(ev.metadata.host_pid, undefined);
    assert.strictEqual(ev.metadata.path, '/Users/gordon/dev/foo');
  } finally {
    setExecSync(nodeExecSync);
  }
});

test('collectClaudeSessions - detects active process without session file', async (t) => {
  setExecSync((cmd) => {
    if (cmd.includes('pgrep -f')) return '1002\n';
    if (cmd.includes('lsof -p 1002')) return '/some/other/path\n';
    return '';
  });

  try {
    const events = await collectClaudeSessions({ claude: { enabled: true } }, join(__dirname, 'non-existent'));

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].agent_id, 'claude-1002');
    assert.strictEqual(events[0].metadata.state, 'active');
    assert.strictEqual(events[0].metadata.path, '/some/other/path');
  } finally {
    setExecSync(nodeExecSync);
  }
});
