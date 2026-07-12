import test from 'node:test';
import assert from 'node:assert';
import { collectClaudeSessions, setExecSync } from '../claude.mjs';
import { execSync as nodeExecSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, 'fixtures', 'claude');

test('collectClaudeSessions - detects active session from process and file', async (t) => {
  setExecSync((cmd) => {
    if (cmd.includes('pgrep -f')) return '1001\n';
    if (cmd.includes('lsof -p 1001')) return '/path/to/my-project\n';
    return '';
  });

  try {
    const events = await collectClaudeSessions({ claude: { enabled: true } }, fixtureDir);

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].agent_id, 'session-123');
    assert.strictEqual(events[0].metadata.state, 'active');
    assert.strictEqual(events[0].metadata.host_pid, 1001);
    assert.strictEqual(events[0].issue_title, 'Fix some bugs');
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

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].agent_id, 'session-123');
    assert.strictEqual(events[0].metadata.state, 'idle');
    assert.strictEqual(events[0].metadata.host_pid, undefined);
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
