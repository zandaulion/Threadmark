import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const filename = process.env.THREADMARK_ENV_FILE || path.join(os.homedir(), '.config/threadmark/server.env');
if (!fs.existsSync(filename)) {
  console.error(`Missing ${filename}. Create the Threadmark environment file first.`);
  process.exit(2);
}
const original = fs.readFileSync(filename, 'utf8');
const publicBaseUrl = valueFor(original, 'PUBLIC_BASE_URL').replace(/\/+$/u, '');
if (!publicBaseUrl.startsWith('https://')) {
  console.error('PUBLIC_BASE_URL must be an HTTPS origin before Gmail can be configured.');
  process.exit(2);
}

const disable = process.argv.includes('--disable');
const clientId = disable ? '' : ask('Threadmark Google OAuth client ID:');
const clientSecret = disable ? '' : ask('Threadmark Google OAuth client secret:');
if (!disable && (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret)) {
  console.error('A Google OAuth web client ID and client secret are required.');
  process.exit(2);
}

let next = original;
next = setValue(next, 'GOOGLE_CLIENT_ID', clientId);
next = setValue(next, 'GOOGLE_CLIENT_SECRET', clientSecret);
next = setValue(next, 'GMAIL_OAUTH_REDIRECT_URI', `${publicBaseUrl}/api/gmail/oauth/callback`);
next = setValue(next, 'GMAIL_TOKEN_ENCRYPTION_KEY', valueFor(next, 'GMAIL_TOKEN_ENCRYPTION_KEY') || crypto.randomBytes(32).toString('base64url'));
next = setValue(next, 'GMAIL_POLL_SECONDS', valueFor(next, 'GMAIL_POLL_SECONDS') || '60');
const temporary = `${filename}.${process.pid}.tmp`;
fs.writeFileSync(temporary, next, { mode: 0o600 });
fs.renameSync(temporary, filename);
fs.chmodSync(filename, 0o600);
console.log(disable ? 'Gmail OAuth configuration disabled.' : 'Gmail OAuth configuration saved without printing secrets.');

function ask(prompt) {
  const command = process.platform === 'linux' ? 'systemd-ask-password' : '';
  if (!command) throw new Error('This helper currently requires systemd-ask-password.');
  const result = spawnSync(command, [prompt], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (result.status !== 0) process.exit(result.status || 1);
  return result.stdout.trim();
}

function valueFor(text, key) {
  return text.match(new RegExp(`^${key}=(.*)$`, 'mu'))?.[1]?.trim() || '';
}

function setValue(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'mu');
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.replace(/\s*$/u, '')}\n${line}\n`;
}
