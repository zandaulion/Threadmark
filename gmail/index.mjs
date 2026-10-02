import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GmailConnector } from './client.mjs';
import { Outbox } from './outbox.mjs';
import { SecretStore } from './secret-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 4393),
  appUrl: (process.env.APP_INTERNAL_URL || 'http://127.0.0.1:4391').replace(/\/+$/u, ''),
  bridgeToken: process.env.BRIDGE_TOKEN || '',
  clientId: String(process.env.GOOGLE_CLIENT_ID || '').trim(),
  clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || '').trim(),
  redirectUri: String(process.env.GMAIL_OAUTH_REDIRECT_URI || '').trim(),
  pollSeconds: Math.min(Math.max(Number(process.env.GMAIL_POLL_SECONDS) || 60, 15), 900),
};
const connector = new GmailConnector(config, new SecretStore(dataDir, process.env.GMAIL_TOKEN_ENCRYPTION_KEY), new Outbox(dataDir));

const server = http.createServer(async (req, res) => {
  if (!constantTime(req.headers['x-bridge-token'], config.bridgeToken)) return json(res, 404, { error: 'not_found' });
  const url = new URL(req.url, 'http://local.invalid');
  try {
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok', ...connector.status() });
    if (url.pathname === '/status' && req.method === 'GET') return json(res, 200, connector.status());
    if (url.pathname === '/oauth/start' && req.method === 'POST') return json(res, 200, { authorizationUrl: connector.beginAuthorization() });
    if (url.pathname === '/oauth/callback' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 200, await connector.completeAuthorization(body.code, body.state));
    }
    if (url.pathname === '/disconnect' && req.method === 'POST') return json(res, 200, await connector.disconnect());
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(`Gmail control request failed: ${error.message}`);
    return json(res, error.status || 500, { error: error.status ? 'gmail_oauth_failed' : 'server_error', message: error.message });
  }
});

server.listen(config.port, config.host, () => console.log(`Threadmark Gmail connector listening on http://${config.host}:${config.port}`));
void connector.start();

const shutdown = () => {
  connector.close();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function constantTime(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 64_000) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON request body.'), { status: 400 }); }
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(payload));
}
