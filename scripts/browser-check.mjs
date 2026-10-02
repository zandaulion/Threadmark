import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [baseUrl, inviteCode, bridgeToken, screenshot = '/tmp/threadmark-dashboard.png'] = process.argv.slice(2);
if (!baseUrl || !inviteCode || !bridgeToken) {
  console.error('Usage: node scripts/browser-check.mjs BASE_URL INVITE_CODE BRIDGE_TOKEN [SCREENSHOT]');
  process.exit(2);
}
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const modulePath = process.env.PLAYWRIGHT_MODULE || path.join(root, 'node_modules/playwright/index.mjs');
const executablePath = process.env.CHROMIUM_EXECUTABLE || '/usr/lib64/chromium-browser/headless_shell';
const { chromium } = await import(pathToFileURL(modulePath));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'allow' });
  const page = await context.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  const groupId = '120363999999999999@g.us';
  const contactId = '15550100001@s.whatsapp.net';
  await fetch(`${baseUrl}/internal/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': bridgeToken },
    body: JSON.stringify({ groups: [{ id: groupId, name: 'Parents · Grade 6B', participantCount: 28 }] }),
  });
  await fetch(`${baseUrl}/internal/contacts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': bridgeToken },
    body: JSON.stringify({ contacts: [{ id: contactId, name: 'Demo Contact A' }, { id: '15550100002@s.whatsapp.net', name: 'Demo Contact B' }] }),
  });
  await page.goto(`${baseUrl}/?invite=${inviteCode}`, { waitUntil: 'networkidle' });
  const notificationIcon = await fetch(`${baseUrl}/icons/icon-192.png`);
  if (!notificationIcon.ok || notificationIcon.headers.get('content-type') !== 'image/png') throw new Error('Notification icon is unavailable');
  await page.getByLabel('Device name').fill('Browser check');
  await page.getByRole('button', { name: 'Activate this device' }).click();
  await page.getByRole('heading', { name: 'Your attention, distilled.' }).waitFor();
  await page.getByRole('button', { name: 'Choose chats' }).click();
  await page.locator('#groups-list').getByText('Parents · Grade 6B', { exact: true }).waitFor();
  await page.locator(`[data-group-id="${groupId}"]`).check();
  await page.getByRole('tab', { name: 'People' }).click();
  await page.getByRole('button', { name: /Import (from phone|\.vcf)/ }).waitFor();
  await page.getByRole('searchbox', { name: 'Search monitored chats' }).fill('Contact A');
  await page.locator('#contacts-list').getByText('Demo Contact A', { exact: true }).waitFor();
  if (await page.locator('#contacts-list').getByText('Demo Contact B', { exact: true }).count()) throw new Error('People search did not filter the contact list');
  await page.locator(`[data-contact-id="${contactId}"]`).check();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.locator('#rules-button').click();
  await page.locator('#jev-state').getByText('Not configured', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New rule' }).click();
  await page.getByLabel('Rule name').fill('Permission form');
  await page.getByLabel('Match', { exact: true }).selectOption('all');
  await page.getByLabel('Phrases, one per line').fill('formular\npână vineri');
  await page.getByLabel('Test with sample text').fill('Trimite formularul până vineri.');
  await page.getByRole('button', { name: 'Test rule' }).click();
  await page.getByText(/Matches \(/).waitFor();
  await page.getByRole('button', { name: 'Save rule' }).click();
  await page.locator('#rules-list').getByText('Permission form', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'New rule' }).click();
  await page.getByLabel('Rule name').fill('Decision needed');
  await page.getByLabel('Detection').selectOption('semantic');
  await page.getByLabel('What should Jev notice?').fill('Someone needs a decision or confirmation from me.');
  await page.getByLabel('Match threshold').fill('82');
  await page.getByRole('button', { name: 'Save rule' }).click();
  await page.locator('#rules-list').getByText('Decision needed', { exact: true }).waitFor();
  await page.locator('#rules-list').getByText('Jev', { exact: true }).waitFor();
  await page.locator('#rules-close').click();
  await fetch(`${baseUrl}/internal/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': bridgeToken },
    body: JSON.stringify({
      id: 'browser-payment-1', groupId, groupName: 'Parents · Grade 6B', senderId: '15550100003@s.whatsapp.net',
      senderName: 'Sample Parent', sentAt: new Date().toISOString(),
      text: 'Bună! Plata pentru excursie este 145 lei. Transfer în RO00TEST0000000000000000 până vineri.',
    }),
  });
  await fetch(`${baseUrl}/internal/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': bridgeToken },
    body: JSON.stringify({
      id: 'browser-meeting-1', sourceId: contactId, sourceName: 'Demo Contact A', sourceKind: 'contact',
      senderId: contactId, senderName: 'Demo Contact A', sentAt: new Date().toISOString(),
      text: 'Ne vedem mâine la 18:30 pentru ședință.',
    }),
  });
  await fetch(`${baseUrl}/internal/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': bridgeToken },
    body: JSON.stringify({
      id: 'browser-reminder-1', groupId, groupName: 'Parents · Grade 6B', senderId: '15550100003@s.whatsapp.net',
      senderName: 'Sample Parent', sentAt: new Date().toISOString(), text: 'Vă rog trimiteți formularul până vineri.',
    }),
  });
  await page.getByText('Payment mentioned: 145 lei').waitFor();
  await page.getByText('Meeting · mâine · 18:30').waitFor();
  await page.locator('[data-item-id^="browser-reminder-1:"] h3').getByText('Permission form', { exact: true }).waitFor();
  await page.locator('[data-item-id^="browser-payment-1:"] .detection-source').getByText('Rule', { exact: true }).waitFor();
  await page.waitForTimeout(350);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (overflow) throw new Error('Desktop layout has horizontal overflow');
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Enable alerts' }).waitFor();
  await page.getByRole('button', { name: 'Rules' }).waitFor();
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (mobileOverflow) throw new Error('Mobile layout has horizontal overflow');
  await page.screenshot({ path: screenshot.replace(/\.png$/u, '-mobile.png'), fullPage: true });
  if (browserErrors.length) throw new Error(`Browser errors: ${browserErrors.join(' | ')}`);
  console.log(JSON.stringify({ ok: true, screenshot, mobile: screenshot.replace(/\.png$/u, '-mobile.png') }));
} finally {
  await browser.close();
}
