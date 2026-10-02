import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { AuthStore, clearCookie, constantTimeTokenMatch, cookieForToken, tokenFromCookie } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { JevDetector } from './jev.mjs';
import { PushService } from './push.mjs';
import { openDatabase, ThreadmarkStore } from './store.mjs';
import { normaliseRule, testRule } from './rules.mjs';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function createThreadmarkServer(options = {}) {
  const config = loadConfig(options.config);
  const ownsDb = !options.db;
  const db = options.db || openDatabase(config.dataDir);
  const store = options.store || new ThreadmarkStore(db);
  const auth = options.auth || new AuthStore(db, { publicBaseUrl: config.publicBaseUrl });
  const push = options.push || new PushService(config, store);
  const jev = options.jev || new JevDetector(config);
  const webHash = hashDirectory(config.webDir);
  const streams = new Set();
  const notifyAndMark = async (item) => {
    await push.notifyItem(item);
    store.markNotified(item.id);
  };

  const broadcast = (name, payload) => {
    const frame = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of streams) response.write(frame);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local.invalid');
    const pathname = url.pathname;
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json(res, 403, { error: 'wrong_origin' });
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok', bridge: store.bridgeStatus() });

      if (pathname === '/api/auth/session' && req.method === 'GET') {
        const device = auth.deviceForToken(tokenFromCookie(req.headers.cookie));
        return json(res, 200, { authenticated: Boolean(device), device });
      }
      if (pathname === '/api/auth/redeem' && req.method === 'POST') {
        const body = await readJson(req);
        const result = auth.redeemInvite(body.code, body.label);
        if (result.error) return json(res, result.error === 'throttled' ? 429 : 400, { error: result.error });
        return json(res, 200, { authenticated: true, device: result.device }, { 'set-cookie': cookieForToken(result.token, config.cookieSecure) });
      }
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        return json(res, 200, { authenticated: false }, { 'set-cookie': clearCookie(config.cookieSecure) });
      }

      if (pathname.startsWith('/api/admin/')) {
        if (!constantTimeTokenMatch(req.headers['x-admin-token'], config.adminToken)) return json(res, 404, { error: 'not_found' });
        if (pathname === '/api/admin/devices' && req.method === 'GET') return json(res, 200, auth.listDevices());
        if (pathname === '/api/admin/invites' && req.method === 'GET') return json(res, 200, auth.listInvites());
        if (pathname === '/api/admin/invites' && req.method === 'POST') {
          const body = await readJson(req);
          return json(res, 201, auth.createInvite(body.label));
        }
        const deviceAction = pathname.match(/^\/api\/admin\/devices\/([a-f0-9-]+)\/(revoke|label)$/u);
        if (deviceAction && req.method === 'POST') {
          const body = await readJson(req);
          const changed = deviceAction[2] === 'revoke'
            ? auth.setDeviceRevoked(deviceAction[1], Boolean(body.revoked))
            : auth.setDeviceLabel(deviceAction[1], body.label);
          return json(res, changed ? 200 : 404, changed ? { ok: true } : { error: 'not_found' });
        }
        const deleteDevice = pathname.match(/^\/api\/admin\/devices\/([a-f0-9-]+)$/u);
        if (deleteDevice && req.method === 'DELETE') {
          const changed = auth.deleteDevice(deleteDevice[1]);
          return json(res, changed ? 200 : 404, changed ? { ok: true } : { error: 'not_found' });
        }
        const revokeInvite = pathname.match(/^\/api\/admin\/invites\/(\d+)\/revoke$/u);
        if (revokeInvite && req.method === 'POST') {
          const changed = auth.revokeInvite(Number(revokeInvite[1]));
          return json(res, changed ? 200 : 404, changed ? { ok: true } : { error: 'not_found' });
        }
        return json(res, 404, { error: 'not_found' });
      }

      if (pathname.startsWith('/internal/')) {
        if (!constantTimeTokenMatch(req.headers['x-bridge-token'], config.bridgeToken)) return json(res, 404, { error: 'not_found' });
        if (pathname === '/internal/routing' && req.method === 'GET') return json(res, 200, store.routingConfig());
        if (pathname === '/internal/groups' && req.method === 'POST') {
          const body = await readJson(req, 1_000_000);
          const groups = store.upsertGroups(Array.isArray(body.groups) ? body.groups : []);
          broadcast('groups', groups);
          return json(res, 200, { accepted: groups.length });
        }
        if (pathname === '/internal/contacts' && req.method === 'POST') {
          const body = await readJson(req, 1_000_000);
          const contacts = store.upsertContacts(Array.isArray(body.contacts) ? body.contacts : []);
          broadcast('contacts', contacts);
          return json(res, 200, { accepted: contacts.length });
        }
        if (pathname === '/internal/gmail/sources' && req.method === 'POST') {
          const body = await readJson(req, 1_000_000);
          const sources = store.upsertGmailSources(Array.isArray(body.sources) ? body.sources : []);
          broadcast('gmail-sources', sources);
          return json(res, 200, { accepted: sources.length });
        }
        if (pathname === '/internal/events' && req.method === 'POST') {
          const body = await readJson(req, 128_000);
          const selection = store.isSelectedMessage(body);
          if (!selection.source || !selection.selected) return json(res, 200, store.ingestMessage(body));
          const settings = store.settings();
          if (body.direction === 'outgoing') {
            if (!settings.outgoingMonitoring) return json(res, 200, { accepted: false, reason: 'outgoing_disabled', sourceKind: selection.source.kind });
            store.recordContextMessage(body);
            const updates = store.markSourceReplied(body);
            for (const item of updates) broadcast('item', item);
            return json(res, 200, { accepted: true, outgoing: true, items: [], updatedItems: updates });
          }
          const localDetections = store.detectMessage(body);
          const context = settings.contextAware || settings.outgoingMonitoring ? store.recentContext(body) : [];
          const shouldUseJev = !localDetections.length || settings.contextAware || settings.outgoingMonitoring;
          const analysis = shouldUseJev ? await jev.evaluate(body.text, store.applicableSemanticRules(body), {
            includeBuiltIns: !localDetections.length,
            contextAware: settings.contextAware,
            replyNeeded: settings.outgoingMonitoring,
            paymentSafety: true,
            extractDate: true,
            referenceAt: body.sentAt,
            context,
          }) : { available: false, detections: [], signals: {} };
          let detections = [...localDetections, ...(analysis.detections || [])];
          if (analysis.signals?.replyNeeded >= 0.82 && !detections.some((item) => item.type === 'reminder')) {
            const dueAt = new Date(new Date(body.sentAt || Date.now()).valueOf() + settings.replyDelayHours * 3_600_000).toISOString();
            detections.push({
              type: 'reminder', key: 'jev-reply-needed', title: 'Reply requested', confidence: analysis.signals.replyNeeded,
              priority: analysis.signals.urgency || null, amountMinor: null, currency: null, eventAt: dueAt, notify: true,
              details: { detector: 'jev', model: analysis.model, awaitingReply: true, replyProbability: analysis.signals.replyNeeded },
            });
          }
          if (analysis.signals?.suspiciousPayment >= 0.9) {
            for (const detection of detections.filter((item) => item.type === 'payment')) {
              detection.details = { ...(detection.details || {}), safetyAlerts: [...new Set([...(detection.details?.safetyAlerts || []), 'Jev recommends verifying this payment request'])] };
              detection.priority = Math.max(Number(detection.priority) || 0, analysis.signals.suspiciousPayment);
            }
          }
          const contextUpdates = settings.contextAware ? store.applyContextSignals(body, analysis) : [];
          if (analysis.signals?.cancelsPrevious >= 0.86 || analysis.signals?.changesPrevious >= 0.82) detections = [];
          if (!detections.length && selection.source.kind === 'contact' && body.media?.kind === 'image') {
            detections.push({
              type: 'reminder', key: 'contact-photo-review', title: 'Photo needs review', confidence: 1,
              priority: null, amountMinor: null, currency: null, eventAt: null, notify: true,
              details: {
                detector: 'review', needsReview: true, mediaKind: 'image',
                ocrProcessed: Boolean(body.media?.processed), ocrError: body.media?.error || null,
              },
            });
          }
          let result = store.ingestMessage(body, detections, { includeLocal: false });
          if (settings.contextAware || settings.outgoingMonitoring) store.recordContextMessage(body);
          result = { ...result, updatedItems: contextUpdates };
          if (result.sourceKind === 'contact') broadcast('contacts', store.listContacts());
          for (const item of contextUpdates) broadcast('item', item);
          for (const item of result.items || []) {
            broadcast('item', item);
            if (item.notify) void notifyAndMark(item);
          }
          return json(res, 200, result);
        }
        if (pathname === '/internal/status' && req.method === 'POST') {
          const status = store.setBridgeStatus(await readJson(req));
          broadcast('bridge', status);
          return json(res, 200, status);
        }
        return json(res, 404, { error: 'not_found' });
      }

      // Google returns from another origin, so SameSite=Strict deliberately omits
      // the device cookie. The connector's single-use, expiring OAuth state value
      // authenticates this one callback; all other Gmail endpoints require a device.
      if (pathname === '/api/gmail/oauth/callback' && req.method === 'GET') {
        return handleGmailCallback(res, config, url);
      }

      if (pathname.startsWith('/api/')) {
        const device = auth.deviceForToken(tokenFromCookie(req.headers.cookie));
        if (!device) return json(res, 401, { error: 'not_registered' });
        if (pathname === '/api/summary' && req.method === 'GET') return json(res, 200, store.summary());
        if (pathname === '/api/settings' && req.method === 'GET') return json(res, 200, store.settings());
        if (pathname === '/api/settings' && req.method === 'PUT') {
          const settings = store.updateSettings(await readJson(req));
          broadcast('settings', settings);
          return json(res, 200, settings);
        }
        if (pathname === '/api/detection/status' && req.method === 'GET') return json(res, 200, jev.status());
        if (pathname === '/api/detection/test' && req.method === 'POST') {
          const body = await readJson(req);
          const result = await jev.evaluate(body.text);
          return json(res, result.enabled && result.available ? 200 : 503, result);
        }
        if (pathname === '/api/feed' && req.method === 'GET') {
          const status = ['open', 'snoozed', 'done', 'all'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'open';
          const type = ['payment', 'meeting', 'reminder', 'all'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'all';
          return json(res, 200, { items: store.listItems({ status, type }) });
        }
        if (pathname === '/api/groups' && req.method === 'GET') return json(res, 200, { groups: store.listGroups() });
        if (pathname === '/api/contacts' && req.method === 'GET') return json(res, 200, { contacts: store.listContacts() });
        if (pathname === '/api/gmail/sources' && req.method === 'GET') return json(res, 200, { sources: store.listGmailSources() });
        if (pathname === '/api/contacts/lookup' && req.method === 'POST') {
          const body = await readJson(req);
          const digits = String(body.phoneNumber || '').replace(/\D/g, '');
          if (digits.length < 8 || digits.length > 15) return json(res, 400, { error: 'invalid_phone_number' });
          return proxyJson(res, `${config.bridgeControlUrl}/contact-lookup`, 'POST', { phoneNumber: digits }, config.bridgeToken, null, (payload) => {
            if (!payload?.contact) return;
            const contacts = store.upsertContacts([payload.contact]);
            broadcast('contacts', contacts);
          });
        }
        if (pathname === '/api/contacts/import' && req.method === 'POST') {
          const body = await readJson(req, 128_000);
          const requested = (Array.isArray(body.contacts) ? body.contacts : []).map((contact) => ({
            phoneNumber: String(contact?.phoneNumber || '').replace(/\D/g, ''),
            name: String(contact?.name || '').trim().slice(0, 240),
          })).filter((contact) => contact.phoneNumber.length >= 8 && contact.phoneNumber.length <= 15).slice(0, 100);
          if (!requested.length) return json(res, 400, { error: 'invalid_phone_number' });
          const names = new Map(requested.map((contact) => [contact.phoneNumber, contact.name]));
          return proxyJson(res, `${config.bridgeControlUrl}/contacts-lookup`, 'POST', { phoneNumbers: [...names.keys()] }, config.bridgeToken, null, (payload) => {
            payload.contacts = (Array.isArray(payload.contacts) ? payload.contacts : []).map((contact) => {
              const digits = String(contact.id || '').split('@')[0].replace(/\D/g, '');
              return { ...contact, name: names.get(digits) || contact.name };
            });
            const contacts = store.upsertContacts(payload.contacts);
            broadcast('contacts', contacts);
          });
        }
        if (pathname === '/api/rules' && req.method === 'GET') return json(res, 200, { rules: store.listRules() });
        if (pathname === '/api/rules' && req.method === 'POST') {
          const rule = store.createRule(await readJson(req));
          broadcast('rules', store.listRules());
          return json(res, 201, rule);
        }
        if (pathname === '/api/rules/test' && req.method === 'POST') {
          const body = await readJson(req);
          const rule = normaliseRule(body.rule || {});
          if (rule.kind === 'semantic') {
            const monitor = { ...rule, id: 'test-monitor' };
            const result = await jev.evaluateMonitor(body.text, monitor);
            return json(res, result.enabled && result.available ? 200 : 503, result);
          }
          return json(res, 200, testRule(rule, body.text));
        }
        const ruleAction = pathname.match(/^\/api\/rules\/([a-f0-9-]+)(?:\/(enabled))?$/u);
        if (ruleAction && req.method === 'PUT' && !ruleAction[2]) {
          const rule = store.updateRule(ruleAction[1], await readJson(req));
          if (rule) broadcast('rules', store.listRules());
          return json(res, rule ? 200 : 404, rule || { error: 'not_found' });
        }
        if (ruleAction && req.method === 'POST' && ruleAction[2] === 'enabled') {
          const body = await readJson(req);
          const rule = store.setRuleEnabled(ruleAction[1], Boolean(body.enabled));
          if (rule) broadcast('rules', store.listRules());
          return json(res, rule ? 200 : 404, rule || { error: 'not_found' });
        }
        if (ruleAction && req.method === 'DELETE' && !ruleAction[2]) {
          const deleted = store.deleteRule(ruleAction[1]);
          if (deleted) broadcast('rules', store.listRules());
          return json(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: 'not_found' });
        }
        const groupSelection = pathname.match(/^\/api\/groups\/(.+)\/selection$/u);
        if (groupSelection && req.method === 'POST') {
          const body = await readJson(req);
          const id = decodeURIComponent(groupSelection[1]);
          const changed = store.selectGroup(id, Boolean(body.selected));
          if (changed) broadcast('groups', store.listGroups());
          return json(res, changed ? 200 : 404, changed ? { ok: true } : { error: 'not_found' });
        }
        const contactSelection = pathname.match(/^\/api\/contacts\/(.+)\/selection$/u);
        if (contactSelection && req.method === 'POST') {
          const body = await readJson(req);
          const id = decodeURIComponent(contactSelection[1]);
          const changed = store.selectContact(id, Boolean(body.selected));
          if (changed) broadcast('contacts', store.listContacts());
          return json(res, changed ? 200 : 404, changed ? { ok: true } : { error: 'not_found' });
        }
        const gmailSelection = pathname.match(/^\/api\/gmail\/sources\/(.+)\/selection$/u);
        if (gmailSelection && req.method === 'POST') {
          const body = await readJson(req);
          const id = decodeURIComponent(gmailSelection[1]);
          const changed = store.selectGmailSource(id, Boolean(body.selected));
          if (changed) broadcast('gmail-sources', store.listGmailSources());
          return json(res, changed ? 200 : 404, changed ? { ok: true } : { error: 'not_found' });
        }
        const itemStatus = pathname.match(/^\/api\/items\/(.+)\/status$/u);
        if (itemStatus && req.method === 'POST') {
          const body = await readJson(req);
          const item = store.setItemStatus(decodeURIComponent(itemStatus[1]), body.status);
          if (item) broadcast('item', item);
          return json(res, item ? 200 : 404, item || { error: 'not_found' });
        }
        const itemFeedback = pathname.match(/^\/api\/items\/(.+)\/feedback$/u);
        if (itemFeedback && req.method === 'POST') {
          const item = store.setItemFeedback(decodeURIComponent(itemFeedback[1]), await readJson(req));
          if (item) broadcast('item', item);
          return json(res, item ? 200 : 400, item || { error: 'invalid_feedback' });
        }
        const itemSnooze = pathname.match(/^\/api\/items\/(.+)\/snooze$/u);
        if (itemSnooze && req.method === 'POST') {
          const item = store.snoozeItem(decodeURIComponent(itemSnooze[1]), (await readJson(req)).until);
          if (item) broadcast('item', item);
          return json(res, item ? 200 : 400, item || { error: 'invalid_snooze' });
        }
        const itemCalendar = pathname.match(/^\/api\/items\/(.+)\/calendar\.ics$/u);
        if (itemCalendar && req.method === 'GET') {
          const item = store.itemById(decodeURIComponent(itemCalendar[1]));
          if (!item?.eventAt) return json(res, 404, { error: 'date_not_available' });
          return calendar(res, item);
        }
        if (pathname === '/api/stream' && req.method === 'GET') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
          streams.add(res);
          const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 20_000);
          req.on('close', () => { clearInterval(keepAlive); streams.delete(res); });
          return;
        }
        if (pathname === '/api/push/key' && req.method === 'GET') return json(res, 200, { enabled: push.enabled, publicKey: push.publicKey || null });
        if (pathname === '/api/push/subscription' && req.method === 'POST') {
          const saved = store.saveSubscription(device.id, await readJson(req, 32_000));
          return json(res, saved ? 201 : 400, saved ? { ok: true } : { error: 'invalid_subscription' });
        }
        if (pathname === '/api/whatsapp/status' && req.method === 'GET') {
          return proxyJson(res, `${config.bridgeControlUrl}/status`, 'GET', null, config.bridgeToken, store.bridgeStatus());
        }
        if (pathname === '/api/whatsapp/pairing-code' && req.method === 'POST') {
          const body = await readJson(req);
          const digits = String(body.phoneNumber || '').replace(/\D/g, '');
          if (digits.length < 8 || digits.length > 15) return json(res, 400, { error: 'invalid_phone_number' });
          return proxyJson(res, `${config.bridgeControlUrl}/pairing-code`, 'POST', { phoneNumber: digits }, config.bridgeToken);
        }
        if (pathname === '/api/whatsapp/qr.svg' && req.method === 'GET') {
          return proxyAsset(res, `${config.bridgeControlUrl}/qr.svg`, config.bridgeToken, 'image/svg+xml');
        }
        if (pathname === '/api/gmail/status' && req.method === 'GET') {
          return proxyJson(res, `${config.gmailControlUrl}/status`, 'GET', null, config.bridgeToken,
            { configured: false, connection: 'not_configured', account: null, degraded: true });
        }
        if (pathname === '/api/gmail/connect' && req.method === 'POST') {
          return proxyJson(res, `${config.gmailControlUrl}/oauth/start`, 'POST', {}, config.bridgeToken);
        }
        if (pathname === '/api/gmail/disconnect' && req.method === 'POST') {
          return proxyJson(res, `${config.gmailControlUrl}/disconnect`, 'POST', {}, config.bridgeToken);
        }
        return json(res, 404, { error: 'not_found' });
      }

      if (serveStatic(req, res, pathname, config.webDir, webHash)) return;
      return json(res, 404, { error: 'not_found' });
    } catch (error) {
      console.error(error);
      return json(res, error?.status || 500, { error: error?.status ? 'invalid_request' : 'server_error', message: error?.message || 'Unexpected error' });
    }
  });

  const scheduler = setInterval(() => {
    for (const item of store.dueNotifications()) void notifyAndMark(item);
    const day = store.digestDue();
    if (day) {
      void push.notifyDigest(store.summary()).then(() => store.markDigestSent(day));
    }
    store.prune(config.retentionDays);
  }, 60_000);
  scheduler.unref();

  const close = () => new Promise((resolve, reject) => server.close((error) => {
    clearInterval(scheduler);
    if (ownsDb) db.close();
    if (error) reject(error); else resolve();
  }));
  return { server, db, store, auth, jev, close, config };
}

function calendar(res, item) {
  const start = new Date(item.eventAt);
  const end = new Date(start.valueOf() + (item.type === 'meeting' ? 3_600_000 : 30 * 60_000));
  const stamp = (value) => value.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
  const escape = (value) => String(value || '').replace(/\\/gu, '\\\\').replace(/\n/gu, '\\n').replace(/,/gu, '\\,').replace(/;/gu, '\\;');
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Threadmark//EN', 'BEGIN:VEVENT',
    `UID:${escape(item.id)}@threadmark`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(item.title)}`, `DESCRIPTION:${escape(item.text)}`, `LOCATION:${escape(item.source?.name)}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="threadmark-item.ics"', 'cache-control': 'no-store' });
  res.end(body);
}

async function proxyJson(res, target, method, body, token, fallback = null, onSuccess = null) {
  try {
    const response = await fetch(target, {
      method,
      headers: { 'x-bridge-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    if (response.ok && onSuccess) onSuccess(payload);
    return json(res, response.status, payload);
  } catch (error) {
    if (fallback) return json(res, 200, { ...fallback, degraded: true });
    return json(res, 503, { error: 'bridge_unavailable' });
  }
}

async function handleGmailCallback(res, config, url) {
  const destination = new URL(config.publicBaseUrl || '/','http://local.invalid');
  destination.searchParams.set('gmail', 'error');
  if (url.searchParams.get('error')) {
    destination.searchParams.set('reason', url.searchParams.get('error'));
    return redirect(res, publicLocation(destination, config));
  }
  try {
    const response = await fetch(`${config.gmailControlUrl}/oauth/callback`, {
      method: 'POST',
      headers: { 'x-bridge-token': config.bridgeToken, 'content-type': 'application/json' },
      body: JSON.stringify({ code: url.searchParams.get('code'), state: url.searchParams.get('state') }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('oauth_failed');
    destination.searchParams.set('gmail', 'connected');
    destination.searchParams.delete('reason');
  } catch {
    destination.searchParams.set('reason', 'oauth_failed');
  }
  return redirect(res, publicLocation(destination, config));
}

function publicLocation(url, config) {
  return config.publicBaseUrl ? url.toString() : `/${url.search}`;
}

function redirect(res, location) {
  res.writeHead(303, { location, 'cache-control': 'no-store' });
  res.end();
}

async function proxyAsset(res, target, token, contentType) {
  try {
    const response = await fetch(target, { headers: { 'x-bridge-token': token }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return json(res, response.status, { error: 'qr_unavailable' });
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    return json(res, 503, { error: 'bridge_unavailable' });
  }
}

function serveStatic(req, res, pathname, webDir, webHash) {
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  const clean = pathname === '/' ? '/index.html' : pathname === '/bust' ? '/bust.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(clean); } catch { return false; }
  if (decoded.includes('..') || decoded.includes('\\') || decoded.split('/').some((part) => part.startsWith('.'))) return false;
  const filename = path.resolve(webDir, `.${decoded}`);
  if (!filename.startsWith(`${webDir}${path.sep}`) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) return false;
  const contentType = CONTENT_TYPES[path.extname(filename)];
  if (!contentType) return false;
  const isWorker = decoded === '/sw.js';
  const body = isWorker ? Buffer.from(fs.readFileSync(filename, 'utf8').replaceAll('__BUILD_VERSION__', webHash)) : fs.readFileSync(filename);
  const noStore = isWorker || decoded === '/bust.html';
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': noStore ? 'no-cache, no-store, must-revalidate' : 'no-cache, must-revalidate',
    'x-content-type-options': 'nosniff',
    ...(isWorker ? { 'service-worker-allowed': '/' } : {}),
    ...(decoded === '/bust.html' ? { 'clear-site-data': '"cache"' } : {}),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function hashDirectory(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) { hash.update(path.relative(dir, full)); hash.update(fs.readFileSync(full)); }
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(payload));
}

async function readJson(req, maxBytes = 64_000) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > maxBytes) throw Object.assign(new Error('Request body is too large'), { status: 413 });
  }
  try { return text ? JSON.parse(text) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON request body'), { status: 400 }); }
}

function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; }
  catch { return false; }
}
