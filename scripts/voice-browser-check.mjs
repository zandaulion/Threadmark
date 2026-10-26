// Synthetic fixtures only; starts a temporary app and never connects to WhatsApp or TypeSafe.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createThreadmarkServer } from '../app/server/server.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.resolve(process.argv[2] || '/tmp/threadmark-voice-browser');
fs.mkdirSync(output, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-voice-browser-'));
const sourceId = '15550100001@s.whatsapp.net';
const baseNote = { sourceId, sourceKind: 'contact', senderName: 'Demo speaker', sourceName: 'Demo contact',
  sentAt: new Date().toISOString(), direction: 'incoming', durationSeconds: 18, attempt: 1 };
const failed = { ...baseNote, id: 'demo-failed', status: 'failed', error: 'local_processing_failed', retryUntil: new Date(Date.now() + 3600_000).toISOString() };
let retries = 0;
let jevCalls = 0;
const bridge = http.createServer(async (req, res) => {
  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ configured: false, connection: 'disconnected', account: null }));
    return;
  }
  assert.equal(req.url, '/voice/retry');
  for await (const _ of req) {} // Consume the authenticated retry request.
  retries++;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ...failed, status: 'queued', error: null, attempt: 2 }));
});
await new Promise((resolve) => bridge.listen(0, '127.0.0.1', resolve));
const instance = createThreadmarkServer({ config: { dataDir, webDir: path.join(root, 'app/web'),
  cookieSecure: false, adminToken: 'a'.repeat(64), bridgeToken: 'b'.repeat(64),
  bridgeControlUrl: `http://127.0.0.1:${bridge.address().port}`,
  gmailControlUrl: `http://127.0.0.1:${bridge.address().port}`, gmailDevControlUrl: `http://127.0.0.1:${bridge.address().port}` },
  push: { enabled: false, publicKey: '', notifyItem: async () => {} },
  jev: { status: () => ({ enabled: true, provider: 'Synthetic fake', model: 'test', threshold: 0.78 }),
    evaluate: async () => { jevCalls++; throw new Error('The voice browser test must never call semantic inference'); } } });
instance.store.upsertContacts([{ id: sourceId, name: 'Demo contact' }]);
instance.store.selectContact(sourceId, true);
await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${instance.server.address().port}`;
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || path.join(root, 'node_modules/playwright/index.mjs')));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/usr/lib64/chromium-browser/headless_shell',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const publish = async (note) => {
  const response = await fetch(`${base}/internal/voice-notes`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': 'b'.repeat(64) }, body: JSON.stringify(note) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
};
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/?invite=${instance.auth.createInvite('Synthetic voice browser').code}`);
  await page.getByLabel('Device name').fill('Synthetic voice browser');
  await page.getByRole('button', { name: 'Activate this device' }).click();
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: 'Voice messages', exact: true }).click();
  await page.getByText('No voice messages yet', { exact: true }).waitFor();
  await page.locator('#settings-button').click();
  await page.getByLabel('Transcribe voice messages locally', { exact: true }).check();
  assert.equal(await page.getByLabel(/^Read attachments locally/u).isChecked(), false);
  assert.equal(await page.getByLabel('Find actions in transcripts', { exact: true }).isChecked(), false);
  await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
  await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
  await publish({ ...baseNote, id: 'demo-ready', status: 'ready', transcript: 'Salut! Totul este bine. Ne auzim când ai timp.' });
  await publish({ ...baseNote, id: 'demo-processing', status: 'transcribing' });
  await publish({ ...baseNote, id: 'demo-queued', status: 'queued' });
  await publish(failed);
  await page.locator('[data-voice-id="demo-ready"] .voice-transcript').getByText('Salut!', { exact: false }).waitFor();
  await page.locator('[data-voice-id="demo-processing"]').getByText('Transcribing…', { exact: true }).waitFor();
  await page.locator('[data-voice-id="demo-queued"]').getByText('Waiting to transcribe', { exact: true }).waitFor();
  await page.locator('[data-voice-id="demo-failed"]').getByRole('button', { name: 'Retry transcription' }).click();
  await page.locator('[data-voice-id="demo-failed"]').getByText('Waiting to transcribe', { exact: true }).waitFor();
  assert.equal(retries, 1);
  await publish({ ...failed, status: 'ready', attempt: 2, transcript: 'Please send the signed form tomorrow.' });
  await page.locator('[data-voice-id="demo-failed"] .voice-transcript').getByText('Please send the signed form tomorrow.', { exact: true }).waitFor();
  assert.equal(instance.store.listItems({}).length, 0);
  assert.equal(jevCalls, 0);
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: path.join(output, 'voice-desktop.png'), fullPage: true });
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no overflow at ${width}px`);
    await page.screenshot({ path: path.join(output, `voice-${width}.png`), fullPage: true });
  }
  await publish({ ...baseNote, id: 'demo-escaped', status: 'ready', transcript: '<img src=x onerror=alert(1)>' });
  await page.locator('[data-voice-id="demo-escaped"] .voice-transcript').getByText('<img src=x onerror=alert(1)>', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-voice-id="demo-escaped"] img').count(), 0, 'transcription is escaped');
  await page.getByRole('tab', { name: /Dev,/ }).click();
  await page.locator('#voice-view-tab').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#voice-view-tab').isVisible(), false);
  assert.equal(await page.locator('[data-voice-id]').count(), 0, 'personal transcripts are absent from Dev');
  // A second page deliberately has no SSE, exercising foreground reconciliation.
  const foreground = await context.newPage();
  foreground.on('pageerror', (error) => errors.push(error.message));
  await foreground.addInitScript(() => {
    window.EventSource = class { static CLOSED = 2; readyState = 1; addEventListener() {} close() {} };
  });
  await foreground.goto(`${base}/?profile=personal`);
  await foreground.getByRole('tab', { name: 'Voice messages', exact: true }).click();
  await publish({ ...baseNote, id: 'demo-foreground', status: 'ready', transcript: 'This transcript arrived while the app was in the background.' });
  await foreground.waitForTimeout(850);
  await foreground.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await foreground.locator('[data-voice-id="demo-foreground"]').waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, retries, semanticCalls: jevCalls, screenshots: output }));
} finally {
  await browser.close();
  await instance.close();
  await new Promise((resolve) => bridge.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
