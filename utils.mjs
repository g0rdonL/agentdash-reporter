import { readFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { homedir } from 'os';

export const VERSION = '1.0.0';

export function loadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

export function resolvePath(p) {
  return p ? p.replace(/^~/, homedir()) : null;
}

export function httpPost(url, body, headers = {}) {
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

export function pathName(p) {
  if (!p || p === 'unknown') return 'unknown';
  const parts = p.split('/').filter(Boolean);
  const name = parts[parts.length - 1] || p;
  if (['tmp', 'dev', 'worktree', 'worktrees'].includes(name) && parts.length >= 2) {
    return parts.slice(-2).join('/');
  }
  return name;
}
