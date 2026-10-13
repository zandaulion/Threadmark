import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createThreadmarkServer } from '../app/server/server.mjs';
import { ENV_LAYOUT, parseEnv, writeEnvFiles } from '../scripts/env-layout.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bridgeToken = 'b'.repeat(64);

async function startApp(t, config = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-hardening-'));
  const app = createThreadmarkServer({
    config: {
      dataDir,
      webDir: path.join(root, 'app/web'),
      adminToken: 'a'.repeat(64),
      bridgeToken,
      publicBaseUrl: 'https://threadmark.test',
      cookieSecure: true,
      bridgeControlUrl: 'http://127.0.0.1:1',
      ...config,
    },
    push: { enabled: false, publicKey: '', notifyItem: async () => {} },
    jev: { status: () => ({ enabled: false }), evaluate: async () => ({ available: false, detections: [], signals: {} }) },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  if (app.internalServer) await new Promise((resolve) => app.internalServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return {
    app,
    base: `http://127.0.0.1:${app.server.address().port}`,
    internal: app.internalServer ? `http://127.0.0.1:${app.internalServer.address().port}` : null,
  };
}

test('connector endpoints are served only on the unpublished internal port', async (t) => {
  const { base, internal } = await startApp(t, { internalPort: 1 });
  const headers = { 'x-bridge-token': bridgeToken };
  assert.equal((await fetch(`${base}/internal/routing`, { headers })).status, 404);
  assert.equal((await fetch(`${internal}/internal/routing`, { headers })).status, 200);
  assert.equal((await fetch(`${internal}/internal/routing`)).status, 404);
  assert.equal((await fetch(`${internal}/api/health`)).status, 404);
  assert.equal((await fetch(`${internal}/`)).status, 404);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('pages carry a same-origin content security policy and HSTS', async (t) => {
  const { base } = await startApp(t);
  const page = await fetch(`${base}/`);
  const policy = page.headers.get('content-security-policy');
  assert.match(policy, /script-src 'self';/u);
  assert.match(policy, /connect-src 'self';/u);
  assert.match(policy, /frame-ancestors 'none'/u);
  assert.doesNotMatch(policy, /unsafe-inline/u);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('strict-transport-security'), /max-age=31536000/u);
  const indexHtml = fs.readFileSync(path.join(root, 'app/web/index.html'), 'utf8');
  assert.doesNotMatch(indexHtml, /<script(?![^>]*\bsrc=)[^>]*>/u, 'index.html must not contain inline scripts');
  assert.doesNotMatch(indexHtml, /<style|\sstyle=|\son[a-z]+=/u, 'index.html must not contain inline styles or handlers');
  const bust = await fetch(`${base}/bust`);
  assert.match(bust.headers.get('content-security-policy'), /default-src 'none'/u);
});

test('unexpected server errors do not reveal internal messages', async (t) => {
  const { app, base } = await startApp(t);
  app.store.bridgeStatus = () => { throw new Error('SQLITE_CORRUPT at /data/threadmark.sqlite'); };
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'server_error' });
});

test('each container environment file holds only the secrets that container reads', () => {
  assert.deepEqual(ENV_LAYOUT['bridge.env'], ['BRIDGE_TOKEN']);
  for (const secret of ['GOOGLE_CLIENT_SECRET', 'GMAIL_TOKEN_ENCRYPTION_KEY']) {
    assert.ok(!ENV_LAYOUT['app.env'].includes(secret));
  }
  for (const secret of ['ADMIN_TOKEN', 'TYPESAFE_API_KEY', 'VAPID_PRIVATE_KEY']) {
    assert.ok(!ENV_LAYOUT['gmail.env'].includes(secret));
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-env-'));
  try {
    writeEnvFiles(directory, { BRIDGE_TOKEN: bridgeToken, ADMIN_TOKEN: 'a'.repeat(64), GOOGLE_CLIENT_SECRET: 'secret' });
    const bridge = parseEnv(fs.readFileSync(path.join(directory, 'bridge.env'), 'utf8'));
    assert.deepEqual(bridge, { BRIDGE_TOKEN: bridgeToken });
    assert.equal(fs.statSync(path.join(directory, 'gmail.env')).mode & 0o777, 0o600);
    assert.throws(() => writeEnvFiles(directory, {}), /refusing to overwrite/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
