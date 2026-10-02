import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadConfig(overrides = {}) {
  const typesafeApiKey = String(process.env.TYPESAFE_API_KEY || '').trim();
  return {
    appDir,
    webDir: path.join(appDir, 'web'),
    dataDir: process.env.DATA_DIR || path.join(appDir, 'data'),
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 4391),
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    cookieSecure: process.env.COOKIE_SECURE !== '0',
    adminToken: process.env.ADMIN_TOKEN || '',
    bridgeToken: process.env.BRIDGE_TOKEN || '',
    bridgeControlUrl: (process.env.BRIDGE_CONTROL_URL || 'http://127.0.0.1:4392').replace(/\/+$/, ''),
    gmailControlUrl: (process.env.GMAIL_CONTROL_URL || 'http://127.0.0.1:4393').replace(/\/+$/, ''),
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
    vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.invalid',
    retentionDays: positiveInt(process.env.RETENTION_DAYS, 30),
    typesafeApiKey,
    jevEnabled: process.env.JEV_ENABLED !== '0' && Boolean(typesafeApiKey),
    jevModel: process.env.JEV_MODEL || 'jev-latest',
    jevThreshold: boundedNumber(process.env.JEV_THRESHOLD, 0.78, 0.5, 0.99),
    jevInvoiceThreshold: boundedNumber(process.env.JEV_INVOICE_THRESHOLD, 0.68, 0.5, 0.99),
    jevTimeoutMs: boundedNumber(process.env.JEV_TIMEOUT_MS, 4_500, 500, 8_000),
    ...overrides,
  };
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
