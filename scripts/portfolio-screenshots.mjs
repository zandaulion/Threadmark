import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createThreadmarkServer } from '../app/server/server.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputDir = path.resolve(process.argv[2] || path.join(root, 'docs/images/portfolio'));
const playwrightModule = process.env.PLAYWRIGHT_MODULE || path.join(root, 'node_modules/playwright/index.mjs');
const chromiumExecutable = process.env.CHROMIUM_EXECUTABLE || '/usr/lib64/chromium-browser/headless_shell';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-portfolio-'));
const adminToken = 'a'.repeat(64);
const bridgeToken = 'b'.repeat(64);
const groupId = '120363999999999999@g.us';
const familyGroupId = '120363888888888888@g.us';
const demoStudentId = '15550100001@s.whatsapp.net';
const exampleContactId = '15550100002@s.whatsapp.net';

const { publicKey: portfolioPushKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const portfolioPushJwk = portfolioPushKey.export({ format: 'jwk' });
const portfolioVapidKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(portfolioPushJwk.x, 'base64url'),
  Buffer.from(portfolioPushJwk.y, 'base64url'),
]).toString('base64url');

fs.mkdirSync(outputDir, { recursive: true });

const futureIso = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const pastIso = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const portfolioJev = {
  status: () => ({
    enabled: true,
    provider: 'TypeSafe AI',
    model: 'jev-portfolio',
    threshold: 0.78,
    lastSuccessAt: new Date().toISOString(),
    lastFailureAt: null,
  }),
  async evaluate(text, monitors = [], options = {}) {
    const message = String(text || '').toLocaleLowerCase('ro');
    const delivery = monitors.find((monitor) => monitor.name === 'Deliveries and reservations');
    const school = monitors.find((monitor) => monitor.name === 'School or family administration');
    let match = null;
    let confidence = 0;
    let urgency = 0.42;
    let eventAt = null;
    if (delivery && /(awb|colet|curier|rezervare|bilet)/u.test(message)) {
      match = delivery;
      confidence = 0.94;
      urgency = 0.67;
      eventAt = futureIso(28);
    } else if (school && /(manual|acord|material|școal|scoala)/u.test(message)) {
      match = school;
      confidence = 0.92;
      urgency = /(astăzi|azi|urgent)/u.test(message) ? 0.91 : 0.73;
      eventAt = futureIso(72);
    }
    const signals = { urgency, changesPrevious: 0.04, cancelsPrevious: 0.02, replyNeeded: 0.18, suspiciousPayment: 0.03 };
    const detections = match ? [{
      type: match.category,
      key: `jev-monitor-${match.id}`,
      title: match.name,
      confidence,
      priority: urgency,
      amountMinor: null,
      currency: null,
      eventAt,
      notify: match.notify,
      details: {
        detector: 'jev',
        monitorId: match.id,
        model: 'jev-portfolio',
        probability: confidence,
        threshold: match.threshold,
        urgency,
        dueAtSource: eventAt ? 'semantic-demo' : null,
      },
    }] : [];
    return {
      ...this.status(),
      available: true,
      model: 'jev-portfolio',
      scores: options.includeBuiltIns === false ? {} : { payment: 0.03, meeting: 0.06, reminder: match ? confidence : 0.08 },
      signals,
      date: eventAt ? { dueAt: eventAt, source: 'semantic-demo' } : null,
      monitorScores: Object.fromEntries(monitors.map((monitor) => [monitor.id, monitor.id === match?.id ? confidence : 0.06])),
      detections,
    };
  },
  async evaluateMonitor(text, monitor) {
    const result = await this.evaluate(text, [monitor], { includeBuiltIns: false });
    const probability = Number(result.monitorScores?.[monitor.id] || 0);
    return { ...result, matched: probability >= monitor.threshold, probability, threshold: monitor.threshold };
  },
};

const app = createThreadmarkServer({
  config: {
    dataDir,
    webDir: path.join(root, 'app/web'),
    adminToken,
    bridgeToken,
    publicBaseUrl: 'http://127.0.0.1',
    cookieSecure: false,
    bridgeControlUrl: 'http://127.0.0.1:1',
  },
  push: { enabled: true, publicKey: portfolioVapidKey, notifyItem: async () => {} },
  jev: portfolioJev,
});

let browser;
try {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
  const adminHeaders = { 'content-type': 'application/json', 'x-admin-token': adminToken };
  const bridgeHeaders = { 'content-type': 'application/json', 'x-bridge-token': bridgeToken };

  const post = async (pathname, body, headers = bridgeHeaders) => {
    const response = await fetch(`${baseUrl}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  };

  await post('/internal/groups', { groups: [
    { id: groupId, name: 'Parents · Grade 6B', participantCount: 28 },
    { id: familyGroupId, name: 'Family plans', participantCount: 6 },
  ] });
  await post('/internal/contacts', { contacts: [
    { id: demoStudentId, name: 'Demo Student' },
    { id: exampleContactId, name: 'Example Contact' },
  ] });
  await post('/internal/status', { connection: 'connected', account: '+1 555 010 0000', updatedAt: new Date().toISOString() });
  const invite = await post('/api/admin/invites', { label: 'Portfolio preview' }, adminHeaders);

  const { chromium } = await import(pathToFileURL(playwrightModule));
  browser = await chromium.launch({
    executablePath: chromiumExecutable,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'allow', deviceScaleFactor: 1 });
  await context.grantPermissions(['notifications'], { origin: baseUrl });
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });

  await page.goto(`${baseUrl}/?invite=${invite.code}`, { waitUntil: 'networkidle' });
  await page.getByLabel('Device name').fill('Portfolio preview');
  await page.getByRole('button', { name: 'Activate this device' }).click();
  await page.getByRole('heading', { name: 'Your attention, distilled.' }).waitFor();

  const apiPost = async (pathname, body) => {
    const result = await page.evaluate(async ({ pathname, body }) => {
      const response = await fetch(pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { ok: response.ok, status: response.status, text: await response.text() };
    }, { pathname, body });
    if (!result.ok) throw new Error(`${pathname} returned HTTP ${result.status}: ${result.text}`);
    return JSON.parse(result.text);
  };

  await apiPost(`/api/groups/${encodeURIComponent(groupId)}/selection`, { selected: true });
  await apiPost(`/api/groups/${encodeURIComponent(familyGroupId)}/selection`, { selected: true });
  await apiPost(`/api/contacts/${encodeURIComponent(demoStudentId)}/selection`, { selected: true });
  await apiPost(`/api/contacts/${encodeURIComponent(exampleContactId)}/selection`, { selected: true });

  await apiPost('/api/rules', {
    name: 'Permission forms', kind: 'phrase', terms: ['formular', 'autorizație'], matchMode: 'any',
    category: 'reminder', scope: 'all', sourceIds: [], notify: true, enabled: true,
  });
  await apiPost('/api/rules', {
    name: 'Deliveries and reservations', kind: 'semantic',
    condition: 'A parcel, booking, ticket, address, pickup, cancellation, or reservation requires attention.',
    category: 'reminder', threshold: 0.78, scope: 'all', sourceIds: [], notify: true, enabled: true,
  });
  await apiPost('/api/rules', {
    name: 'School or family administration', kind: 'semantic',
    condition: 'A school or family message asks for forms, materials, permissions, or action after a schedule change.',
    category: 'reminder', threshold: 0.8, scope: 'all', sourceIds: [], notify: true, enabled: true,
  });

  const events = [
    {
      id: 'portfolio-payment', groupId, groupName: 'Parents · Grade 6B', senderId: '15550100003@s.whatsapp.net',
      senderName: 'Sample Parent', sentAt: pastIso(8),
      text: 'Plata pentru excursia la muzeu este 145 lei. Transfer în contul RO00TEST0000000000000000 până vineri.',
    },
    {
      id: 'portfolio-meeting', groupId, groupName: 'Parents · Grade 6B', senderId: '15550100004@s.whatsapp.net',
      senderName: 'Example Teacher', sentAt: pastIso(18),
      text: 'Meeting with parents: joi la 18:30, în sala 12. Vă rog să confirmați participarea.',
    },
    {
      id: 'portfolio-delivery', sourceId: exampleContactId, sourceName: 'Example Contact', sourceKind: 'contact',
      senderId: exampleContactId, senderName: 'Example Contact', sentAt: pastIso(27),
      text: 'Curierul a confirmat coletul. AWB 000123456; ridicare mâine de la recepție până la 17:00.',
    },
    {
      id: 'portfolio-school', groupId, groupName: 'Parents · Grade 6B', senderId: '15550100005@s.whatsapp.net',
      senderName: 'Demo Parent', sentAt: pastIso(38),
      text: 'Pentru luni, copiii trebuie să aducă manualul de științe și acordul semnat pentru laborator.',
    },
    {
      id: 'portfolio-photo', sourceId: demoStudentId, sourceName: 'Demo Student', sourceKind: 'contact',
      senderId: demoStudentId, senderName: 'Demo Student', sentAt: pastIso(49), text: '[Attachment]',
      media: { kind: 'image', mimeType: 'image/jpeg', processed: false, error: 'no_text_found' },
    },
  ];
  for (const event of events) await post('/internal/events', event);

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Payment mentioned: 145 lei').waitFor();
  await page.locator('#feed').getByText('Deliveries and reservations', { exact: true }).waitFor();
  await page.locator('#feed').getByText('Photo needs review', { exact: true }).waitFor();
  await page.waitForTimeout(300);
  // Headless Chromium reports notification permission as denied even when the
  // isolated context is granted it. Show the untouched first-run CTA instead
  // of recording that browser-only artifact in the portfolio images.
  await page.locator('#alerts-button').evaluate((button) => {
    button.textContent = 'Enable alerts';
    button.disabled = false;
    button.classList.remove('enabled');
    button.setAttribute('aria-pressed', 'false');
  });

  const captures = [];
  const capture = async (name, width, height, description) => {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(180);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (overflow) throw new Error(`${name} has horizontal overflow at ${width}×${height}`);
    const file = path.join(outputDir, name);
    await page.screenshot({ path: file, fullPage: false });
    captures.push({ file: path.relative(root, file), width, height, description });
  };

  await page.evaluate(() => window.scrollTo(0, 0));
  await capture('threadmark-desktop-1440x1000.png', 1440, 1000, 'Desktop attention inbox with synthetic alerts.');

  await page.setViewportSize({ width: 834, height: 1112 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#rules-button').click();
  await page.locator('#rules-dialog[open]').waitFor();
  await capture('threadmark-tablet-rules-834x1112.png', 834, 1112, 'Tablet rules view with local and Jev monitors.');
  await page.locator('#rules-close').click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.feed-heading').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -12));
  await capture('threadmark-mobile-390x844.png', 390, 844, 'Mobile attention inbox with synthetic messages.');

  await page.locator('#mobile-rules-button').click();
  await page.locator('#rules-dialog[open]').waitFor();
  await capture('threadmark-mobile-rules-390x844.png', 390, 844, 'Mobile rules view with the Jev section collapsed.');

  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`);
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), syntheticData: true, captures }, null, 2)}\n`);
  console.log(JSON.stringify({ ok: true, syntheticData: true, outputDir, captures }, null, 2));
} finally {
  if (browser) await browser.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
