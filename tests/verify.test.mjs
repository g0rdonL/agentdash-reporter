import test from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

const REPORTER_PATH = join(process.cwd(), 'reporter.mjs');

function createTempHome() {
  const baseDir = join(tmpdir(), 'agentdash-test-home-');
  return mkdtempSync(baseDir);
}

function runReporter(homeDir, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REPORTER_PATH, ...args], {
      env: {
        ...process.env,
        HOME: homeDir,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test('1. Config missing -> exits 1 with a "config missing" FAIL message', async () => {
  const homeDir = createTempHome();
  try {
    const { code, stdout, stderr } = await runReporter(homeDir, ['--verify']);
    assert.strictEqual(code, 1);
    assert.match(stdout, /FAIL: config missing/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('2. Config present but zero adapters enabled -> exits 1 with the no-adapters FAIL message', async () => {
  const homeDir = createTempHome();
  try {
    mkdirSync(join(homeDir, '.agentdash'), { recursive: true });
    const config = {
      api_key: 'ad_live_test_key',
      happy: { enabled: false },
      kimi: { enabled: false },
      claude: { enabled: false }
    };
    writeFileSync(join(homeDir, '.agentdash', 'config.json'), JSON.stringify(config));

    const { code, stdout, stderr } = await runReporter(homeDir, ['--verify']);
    assert.strictEqual(code, 1);
    assert.match(stdout, /FAIL: no adapters enabled/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('3. Backend unreachable -> exits 1 with a network-error FAIL message', async () => {
  const homeDir = createTempHome();
  try {
    mkdirSync(join(homeDir, '.agentdash'), { recursive: true });
    const config = {
      api_key: 'ad_live_test_key',
      api_url: 'http://127.0.0.1:9', // Pointing at a closed port
      happy: { enabled: true },
      kimi: { enabled: false },
      claude: { enabled: false }
    };
    writeFileSync(join(homeDir, '.agentdash', 'config.json'), JSON.stringify(config));

    const { code, stdout, stderr } = await runReporter(homeDir, ['--verify']);
    assert.strictEqual(code, 1);
    assert.match(stdout, /FAIL: network error/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('4. Happy path: local node:http stub server returning 200 on batch endpoint', async () => {
  const homeDir = createTempHome();
  try {
    // Start local server
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        const payload = JSON.parse(body);
        assert.strictEqual(req.url, '/api/v1/emitter/status/batch');
        assert.strictEqual(req.method, 'POST');
        assert.strictEqual(req.headers['authorization'], 'Bearer ad_live_test_key');
        assert.strictEqual(payload.length, 1);
        assert.strictEqual(payload[0].agent_id, 'verification-test');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count: 1 }));
      });
    });

    // Listen on random port
    const port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(server.address().port);
      });
    });

    mkdirSync(join(homeDir, '.agentdash'), { recursive: true });
    const config = {
      api_key: 'ad_live_test_key',
      api_url: `http://127.0.0.1:${port}`,
      happy: { enabled: true },
      kimi: { enabled: false },
      claude: { enabled: false }
    };
    writeFileSync(join(homeDir, '.agentdash', 'config.json'), JSON.stringify(config));

    const { code, stdout, stderr } = await runReporter(homeDir, ['--verify']);

    server.close();

    assert.strictEqual(code, 0);
    assert.match(stdout, /PASS \(adapters: happy; log: .*reporter\.log\)/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('5. Log-dir writability failure -> exits 1', async () => {
  const homeDir = createTempHome();
  try {
    // Create the directory where the config will reside, but
    // make `.agentdash/reporter.log` a directory itself.
    // This will cause `appendFileSync` on `.agentdash/reporter.log` to throw EISDIR.
    mkdirSync(join(homeDir, '.agentdash'), { recursive: true });
    mkdirSync(join(homeDir, '.agentdash', 'reporter.log'), { recursive: true });

    const config = {
      api_key: 'ad_live_test_key',
      happy: { enabled: true },
      kimi: { enabled: false },
      claude: { enabled: false }
    };
    writeFileSync(join(homeDir, '.agentdash', 'config.json'), JSON.stringify(config));

    const { code, stdout, stderr } = await runReporter(homeDir, ['--verify']);
    assert.strictEqual(code, 1);
    assert.match(stdout, /FAIL: log not writable/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});
