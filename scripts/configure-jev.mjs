import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const destination = process.env.THREADMARK_ENV_FILE || path.join(os.homedir(), '.config/threadmark/server.env');
if (!fs.existsSync(destination)) {
  console.error(`Missing ${destination}. Deploy Threadmark first.`);
  process.exit(2);
}

const disabling = process.argv.includes('--disable');
let apiKey = '';
if (!disabling) {
  const prompt = spawnSync('systemd-ask-password', ['TypeSafe API key for Threadmark:'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (prompt.status !== 0) process.exit(prompt.status || 1);
  apiKey = String(prompt.stdout || '').trim();
  if (!/^[A-Za-z0-9._-]{16,512}$/u.test(apiKey)) {
    console.error('The API key format is not valid. Nothing was changed.');
    process.exit(2);
  }
}

let content = fs.readFileSync(destination, 'utf8');
content = setValue(content, 'JEV_ENABLED', disabling ? '0' : '1');
if (!disabling) content = setValue(content, 'TYPESAFE_API_KEY', apiKey);
content = ensureValue(content, 'JEV_MODEL', 'jev-latest');
content = ensureValue(content, 'JEV_THRESHOLD', '0.78');
content = ensureValue(content, 'JEV_INVOICE_THRESHOLD', '0.68');
content = ensureValue(content, 'JEV_TIMEOUT_MS', '4500');

const temporary = `${destination}.jev-${process.pid}`;
fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
fs.renameSync(temporary, destination);
fs.chmodSync(destination, 0o600);
console.log(disabling
  ? 'Jev disabled. Restart threadmark-app.service to apply the change.'
  : 'Jev configured without printing the key. Restart threadmark-app.service to enable it.');

function setValue(source, name, value) {
  const line = `${name}=${value}`;
  const expression = new RegExp(`^${name}=.*$`, 'mu');
  return expression.test(source) ? source.replace(expression, line) : `${source.replace(/\n*$/u, '\n')}${line}\n`;
}

function ensureValue(source, name, value) {
  return new RegExp(`^${name}=`, 'mu').test(source) ? source : setValue(source, name, value);
}
