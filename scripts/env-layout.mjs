import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Each container receives only the settings it reads, so a compromised
// connector cannot read the other connectors' credentials.
export const ENV_LAYOUT = {
  'app.env': [
    'PUBLIC_BASE_URL', 'COOKIE_SECURE', 'ADMIN_TOKEN', 'BRIDGE_TOKEN',
    'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'RETENTION_DAYS',
    'JEV_ENABLED', 'TYPESAFE_API_KEY', 'JEV_MODEL', 'JEV_THRESHOLD', 'JEV_INVOICE_THRESHOLD', 'JEV_TIMEOUT_MS',
  ],
  'bridge.env': ['BRIDGE_TOKEN'],
  'gmail.env': [
    'BRIDGE_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_OAUTH_REDIRECT_URI',
    'GMAIL_TOKEN_ENCRYPTION_KEY', 'GMAIL_POLL_SECONDS',
  ],
};

export function configDir() {
  return process.env.THREADMARK_CONFIG_DIR
    || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'threadmark');
}

export function writeEnvFiles(directory, values) {
  const targets = Object.keys(ENV_LAYOUT).map((name) => path.join(directory, name));
  const existing = targets.filter((target) => fs.existsSync(target));
  if (existing.length) throw new Error(`${existing.join(', ')} already exists; refusing to overwrite secrets.`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const [name, keys] of Object.entries(ENV_LAYOUT)) {
    const content = keys.map((key) => `${key}=${values[key] ?? ''}`).join('\n');
    fs.writeFileSync(path.join(directory, name), `${content}\n`, { mode: 0o600, flag: 'wx' });
  }
  return targets;
}

export function parseEnv(text) {
  const values = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (match) values[match[1]] = match[2];
  }
  return values;
}
