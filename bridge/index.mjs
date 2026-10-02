import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { Outbox } from './outbox.mjs';
import { normalizeContacts, normalizeGroups, normalizeMessage, resolveContactSourceId } from './normalize.mjs';
import { processMessageMedia } from './media.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, 'data');
const authDir = path.join(dataDir, 'auth');
const appUrl = (process.env.APP_INTERNAL_URL || 'http://127.0.0.1:4391').replace(/\/+$/, '');
const bridgeToken = process.env.BRIDGE_TOKEN || '';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4392);
fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });

const outbox = new Outbox(dataDir);
const logger = createLogger();
let socket = null;
let qr = null;
let stateName = 'connecting';
let account = null;
let reconnectTimer = null;
let delivering = false;
const groupNames = new Map();
const lidToPhone = new Map();
let routing = { sourceIds: new Set(), outgoingMonitoring: false, attachmentProcessing: false };

async function connect() {
  clearTimeout(reconnectTimer);
  stateName = 'connecting';
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  socket = makeWASocket({
    auth: state,
    logger,
    browser: ['Threadmark', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });
  socket.ev.on('creds.update', saveCreds);
  socket.ev.on('connection.update', async (update) => {
    if (update.qr) {
      qr = update.qr;
      stateName = 'pairing';
      queueStatus();
    }
    if (update.connection === 'open') {
      qr = null;
      stateName = 'connected';
      account = socket.user?.id || null;
      queueStatus();
      await refreshRouting();
      try {
        const groups = normalizeGroups(await socket.groupFetchAllParticipating());
        for (const group of groups) groupNames.set(group.id, group.name);
        outbox.put('groups-current', '/internal/groups', { groups });
        void deliver();
      } catch (error) {
        console.error(`Could not load WhatsApp groups: ${error.message}`);
      }
    }
    if (update.connection === 'close') {
      qr = null;
      stateName = 'disconnected';
      queueStatus();
      const statusCode = update.lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) reconnectTimer = setTimeout(() => void connect(), 5000);
    }
  });
  socket.ev.on('groups.update', async () => {
    try {
      const groups = normalizeGroups(await socket.groupFetchAllParticipating());
      for (const group of groups) groupNames.set(group.id, group.name);
      outbox.put('groups-current', '/internal/groups', { groups });
      void deliver();
    } catch (error) { console.error(`Group refresh failed: ${error.message}`); }
  });
  socket.ev.on('contacts.upsert', (contacts) => queueContacts(contacts));
  socket.ev.on('contacts.update', (contacts) => queueContacts(contacts));
  socket.ev.on('chats.upsert', (chats) => queueContacts(chats));
  socket.ev.on('chats.update', (chats) => queueContacts(chats));
  socket.ev.on('messaging-history.set', ({ contacts, chats }) => queueContacts([...(contacts || []), ...(chats || [])]));
  socket.ev.on('lid-mapping.update', ({ lid, pn }) => {
    if (lid && pn) lidToPhone.set(lidUser(lid), pn);
    queueContacts([{ id: pn }]);
  });
  socket.ev.on('messages.upsert', ({ messages, type }) => {
    void handleMessages(messages, type).catch((error) => console.error(`Could not process WhatsApp event: ${error.message}`));
  });

  async function handleMessages(messages, type) {
    if (type !== 'notify') return;
    for (const message of messages) {
      const originalSourceId = message?.key?.remoteJid;
      const resolvedSourceId = await resolveContactSourceId(originalSourceId, async (lid) => {
        const cached = lidToPhone.get(lidUser(lid));
        if (cached) return cached;
        const mapped = await socket?.signalRepository?.lidMapping?.getPNForLID(lid);
        if (mapped) lidToPhone.set(lidUser(lid), mapped);
        return mapped;
      });
      const normalized = normalizeMessage(message, groupNames.get(originalSourceId), resolvedSourceId);
      if (!normalized) continue;
      if (normalized.direction === 'outgoing' && (!routing.outgoingMonitoring || !routing.sourceIds.has(normalized.sourceId))) continue;
      if (normalized.direction === 'incoming' && routing.attachmentProcessing && routing.sourceIds.has(normalized.sourceId) && normalized.media) {
        const processed = await processMessageMedia(message, socket, logger, { tempDir: dataDir });
        if (processed) {
          normalized.media = processed;
          if (processed.extractedText) {
            const label = processed.processor === 'whisper' ? 'Local voice transcript' : 'Local attachment text';
            normalized.text = `${normalized.text}\n\n[${label}]\n${processed.extractedText}`.slice(0, 12_000);
          }
        }
      }
      if (normalized.sourceKind === 'contact') {
        queueContacts([{ id: normalized.sourceId, name: normalized.sourceName }], false);
      }
      outbox.put(`message:${normalized.id}`, '/internal/events', normalized);
    }
    void deliver();
  }
}

async function refreshRouting() {
  if (!bridgeToken) return;
  try {
    const response = await fetch(`${appUrl}/internal/routing`, {
      headers: { 'x-bridge-token': bridgeToken }, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const payload = await response.json();
    routing = {
      sourceIds: new Set(Array.isArray(payload.sourceIds) ? payload.sourceIds : []),
      outgoingMonitoring: Boolean(payload.outgoingMonitoring),
      attachmentProcessing: Boolean(payload.attachmentProcessing),
    };
  } catch {}
}

function lidUser(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

function queueContacts(records, startDelivery = true) {
  for (const contact of normalizeContacts(records)) {
    outbox.put(`contact:${contact.id}`, '/internal/contacts', { contacts: [contact] });
  }
  if (startDelivery) void deliver();
}

function queueStatus() {
  outbox.put('bridge-status', '/internal/status', {
    connection: stateName,
    account,
    lastEventAt: new Date().toISOString(),
  });
  void deliver();
}

async function deliver() {
  if (delivering || !bridgeToken) return;
  delivering = true;
  try {
    for (const event of outbox.pending()) {
      try {
        const response = await fetch(`${appUrl}${event.endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-bridge-token': bridgeToken },
          body: JSON.stringify(event.payload),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        outbox.delivered(event.id);
      } catch (error) {
        outbox.failed(event.id);
        break;
      }
    }
  } finally { delivering = false; }
}

const control = http.createServer(async (req, res) => {
  if (!constantTime(req.headers['x-bridge-token'], bridgeToken)) return sendJson(res, 404, { error: 'not_found' });
  const url = new URL(req.url, 'http://local.invalid');
  if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { status: 'ok', connection: stateName });
  if (url.pathname === '/status' && req.method === 'GET') return sendJson(res, 200, { connection: stateName, account, qrAvailable: Boolean(qr) });
  if (url.pathname === '/qr.svg' && req.method === 'GET') {
    if (!qr) return sendJson(res, 404, { error: 'qr_unavailable' });
    const svg = await QRCode.toString(qr, { type: 'svg', margin: 2, width: 320, color: { dark: '#111827', light: '#ffffff' } });
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(svg);
  }
  if (url.pathname === '/pairing-code' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const phoneNumber = String(body.phoneNumber || '').replace(/\D/g, '');
      if (!socket || phoneNumber.length < 8 || phoneNumber.length > 15) return sendJson(res, 400, { error: 'invalid_request' });
      const code = await socket.requestPairingCode(phoneNumber);
      return sendJson(res, 200, { code });
    } catch (error) {
      return sendJson(res, 503, { error: 'pairing_failed', message: error.message });
    }
  }
  if (url.pathname === '/contact-lookup' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const phoneNumber = String(body.phoneNumber || '').replace(/\D/g, '');
      if (!socket || stateName !== 'connected' || phoneNumber.length < 8 || phoneNumber.length > 15) {
        return sendJson(res, 400, { error: 'invalid_request' });
      }
      const [result] = await socket.onWhatsApp(phoneNumber) || [];
      if (!result?.exists || !result.jid) return sendJson(res, 404, { error: 'contact_not_found' });
      const [contact] = normalizeContacts([{ id: result.jid }]);
      if (!contact) return sendJson(res, 404, { error: 'contact_not_found' });
      queueContacts([contact]);
      return sendJson(res, 200, { contact });
    } catch (error) {
      return sendJson(res, 503, { error: 'contact_lookup_failed', message: error.message });
    }
  }
  if (url.pathname === '/contacts-lookup' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const phoneNumbers = [...new Set((Array.isArray(body.phoneNumbers) ? body.phoneNumbers : [])
        .map((value) => String(value || '').replace(/\D/g, ''))
        .filter((value) => value.length >= 8 && value.length <= 15))].slice(0, 100);
      if (!socket || stateName !== 'connected' || !phoneNumbers.length) return sendJson(res, 400, { error: 'invalid_request' });
      const results = await socket.onWhatsApp(...phoneNumbers) || [];
      const contacts = normalizeContacts(results.filter((result) => result?.exists).map((result) => ({ id: result.jid })));
      queueContacts(contacts);
      return sendJson(res, 200, { contacts });
    } catch (error) {
      return sendJson(res, 503, { error: 'contact_lookup_failed', message: error.message });
    }
  }
  return sendJson(res, 404, { error: 'not_found' });
});

control.listen(port, host, () => console.log(`Threadmark bridge control listening on http://${host}:${port}`));
setInterval(() => void deliver(), 2000).unref();
setInterval(queueStatus, 30_000).unref();
setInterval(() => void refreshRouting(), 15_000).unref();
void connect().catch((error) => {
  console.error(`WhatsApp connection failed: ${error.message}`);
  reconnectTimer = setTimeout(() => void connect(), 5000);
});

function createLogger() {
  const logger = { child: () => logger };
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) logger[level] = () => {};
  return logger;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 32_000) throw new Error('Request too large');
  }
  return text ? JSON.parse(text) : {};
}

function constantTime(candidate, expected) {
  if (!candidate || !expected) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const shutdown = () => {
  clearTimeout(reconnectTimer);
  try { socket?.end?.(new Error('shutdown')); } catch {}
  control.close(() => { outbox.close(); process.exit(0); });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
