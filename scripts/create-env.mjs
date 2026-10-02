import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const publicBaseUrl = process.argv[2]?.replace(/\/+$/, '');
if (!publicBaseUrl?.startsWith('https://')) {
  console.error('Usage: node scripts/create-env.mjs https://threadmark.example');
  process.exit(2);
}
const destination = process.env.THREADMARK_ENV_FILE || path.join(os.homedir(), '.config/threadmark/server.env');
if (fs.existsSync(destination)) {
  console.error(`${destination} already exists; refusing to overwrite secrets.`);
  process.exit(2);
}
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const rawPublic = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]).toString('base64url');
const content = [
  `PUBLIC_BASE_URL=${publicBaseUrl}`,
  'COOKIE_SECURE=1',
  `ADMIN_TOKEN=${crypto.randomBytes(32).toString('hex')}`,
  `BRIDGE_TOKEN=${crypto.randomBytes(32).toString('hex')}`,
  `VAPID_PUBLIC_KEY=${rawPublic}`,
  `VAPID_PRIVATE_KEY=${priv.d}`,
  'VAPID_SUBJECT=mailto:admin@example.invalid',
  'RETENTION_DAYS=30',
  'JEV_ENABLED=0',
  'TYPESAFE_API_KEY=',
  'JEV_MODEL=jev-latest',
  'JEV_THRESHOLD=0.78',
  'JEV_TIMEOUT_MS=4500',
  'GOOGLE_CLIENT_ID=',
  'GOOGLE_CLIENT_SECRET=',
  `GMAIL_OAUTH_REDIRECT_URI=${publicBaseUrl}/api/gmail/oauth/callback`,
  `GMAIL_TOKEN_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64url')}`,
  'GMAIL_POLL_SECONDS=60',
  '',
].join('\n');
fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
fs.writeFileSync(destination, content, { mode: 0o600, flag: 'wx' });
console.log(`Created ${destination} with mode 0600.`);
