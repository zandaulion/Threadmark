import crypto from 'node:crypto';
import { normalizeGmailMessage, messageMetadata } from './normalize.mjs';

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';

export class GmailConnector {
  constructor(config, secretStore, outbox, options = {}) {
    this.config = config;
    this.secretStore = secretStore;
    this.outbox = outbox;
    this.fetch = options.fetch || globalThis.fetch;
    this.credentials = secretStore.load();
    this.routing = new Map();
    this.delivering = false;
    this.syncing = false;
    this.lastEventAt = null;
    this.lastError = null;
    this.timer = null;
  }

  configured() {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.redirectUri && this.secretStore.available());
  }

  status() {
    const connected = Boolean(this.credentials.refreshToken && this.credentials.email);
    return {
      configured: this.configured(),
      connection: !this.configured() ? 'not_configured' : connected ? (this.lastError ? 'error' : 'connected') : 'disconnected',
      account: connected ? this.credentials.email : null,
      lastEventAt: this.lastEventAt,
      error: this.lastError,
      pollSeconds: this.config.pollSeconds,
    };
  }

  async start() {
    await this.refreshRouting();
    if (this.credentials.refreshToken) {
      await this.refreshSources().catch((error) => this.recordError(error));
      await this.sync().catch((error) => this.recordError(error));
    }
    this.timer = setInterval(() => void this.tick(), this.config.pollSeconds * 1000);
    this.timer.unref();
  }

  close() {
    clearInterval(this.timer);
    this.outbox.close();
  }

  beginAuthorization() {
    if (!this.configured()) throw statusError(503, 'Gmail OAuth is not configured.');
    const state = crypto.randomBytes(32).toString('base64url');
    this.credentials = {
      ...this.credentials,
      oauthStateHash: hash(state),
      oauthStateExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    this.secretStore.save(this.credentials);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    }).toString();
    return url.toString();
  }

  async completeAuthorization(code, state) {
    const expected = Buffer.from(String(this.credentials.oauthStateHash || ''), 'hex');
    const supplied = Buffer.from(hash(state), 'hex');
    const expires = new Date(this.credentials.oauthStateExpiresAt || 0);
    if (!code || expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied) || expires <= new Date()) {
      throw statusError(400, 'The Gmail authorization response is invalid or expired.');
    }
    const token = await this.tokenRequest({
      code: String(code), client_id: this.config.clientId, client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri, grant_type: 'authorization_code',
    });
    const refreshToken = token.refresh_token || this.credentials.refreshToken;
    if (!refreshToken) throw statusError(400, 'Google did not return a refresh token. Remove Threadmark from Google Account access and connect again.');
    this.credentials = {
      refreshToken,
      accessToken: token.access_token,
      accessTokenExpiresAt: expiry(token.expires_in),
    };
    const profile = await this.api('/profile');
    this.credentials.email = String(profile.emailAddress || '');
    this.credentials.historyId = String(profile.historyId || '');
    this.credentials.connectedAt = new Date().toISOString();
    this.secretStore.save(this.credentials);
    this.lastError = null;
    await this.refreshSources();
    await this.deliver();
    return this.status();
  }

  async disconnect() {
    const token = this.credentials.refreshToken || this.credentials.accessToken;
    if (token) {
      await this.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }
    this.credentials = {};
    this.secretStore.clear();
    this.lastError = null;
    return this.status();
  }

  async tick() {
    await this.refreshRouting();
    if (this.credentials.refreshToken) await this.sync().catch((error) => this.recordError(error));
    await this.deliver();
  }

  async refreshRouting() {
    if (!this.config.bridgeToken) return;
    try {
      const response = await this.fetch(`${this.config.appUrl}/internal/routing`, {
        headers: { 'x-bridge-token': this.config.bridgeToken }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const payload = await response.json();
      this.routing = new Map((Array.isArray(payload.gmailSources) ? payload.gmailSources : []).map((source) => [source.id, source]));
    } catch {}
  }

  async refreshSources() {
    const labels = await this.api('/labels');
    const visibleSystem = new Set(['INBOX', 'IMPORTANT', 'STARRED']);
    const sources = (Array.isArray(labels.labels) ? labels.labels : [])
      .filter((label) => label.type === 'user' || visibleSystem.has(label.id))
      .map((label) => ({ id: `gmail:label:${label.id}`, name: label.name, kind: 'gmail_label' }));
    this.outbox.put('gmail-labels-current', '/internal/gmail/sources', { sources });
  }

  async sync() {
    if (this.syncing || !this.credentials.refreshToken) return;
    this.syncing = true;
    try {
      if (!this.credentials.historyId) {
        const profile = await this.api('/profile');
        this.credentials.historyId = String(profile.historyId || '');
        this.secretStore.save(this.credentials);
        return;
      }
      let pageToken = '';
      let newestHistoryId = this.credentials.historyId;
      const messageIds = new Set();
      do {
        const params = new URLSearchParams({ startHistoryId: this.credentials.historyId, historyTypes: 'messageAdded', maxResults: '500' });
        if (pageToken) params.set('pageToken', pageToken);
        let history;
        try { history = await this.api(`/history?${params}`); }
        catch (error) {
          if (error.status !== 404) throw error;
          const profile = await this.api('/profile');
          this.credentials.historyId = String(profile.historyId || '');
          this.secretStore.save(this.credentials);
          return;
        }
        for (const record of history.history || []) {
          for (const added of record.messagesAdded || []) if (added.message?.id) messageIds.add(added.message.id);
        }
        newestHistoryId = String(history.historyId || newestHistoryId);
        pageToken = String(history.nextPageToken || '');
      } while (pageToken);
      for (const messageId of messageIds) {
        try { await this.processMessage(messageId); }
        catch (error) {
          // A message can be deleted or moved out of reach between history.list
          // and messages.get. Skip that one message so the checkpoint can still
          // advance instead of retrying the same stale history page forever.
          if (error.status !== 404) throw error;
        }
      }
      this.credentials.historyId = newestHistoryId;
      this.secretStore.save(this.credentials);
      this.lastEventAt = new Date().toISOString();
      this.lastError = null;
    } finally { this.syncing = false; }
  }

  async processMessage(messageId) {
    const metadataMessage = await this.api(`/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
    const metadata = messageMetadata(metadataMessage);
    if (!metadata.senderSourceId || metadata.labelIds.includes('SENT') || metadata.labelIds.includes('DRAFT')) return;
    this.outbox.put(`gmail-sender:${metadata.senderSourceId}`, '/internal/gmail/sources', {
      sources: [{
        id: metadata.senderSourceId,
        name: metadata.sender.name !== metadata.sender.address ? `${metadata.sender.name} · ${metadata.sender.address}` : metadata.sender.address,
        kind: 'gmail_sender',
      }],
    });
    const candidates = [metadata.senderSourceId, ...metadata.labelIds.map((id) => `gmail:label:${id}`)];
    const selectedId = candidates.find((id) => this.routing.has(id));
    if (!selectedId) return;
    const source = this.routing.get(selectedId);
    const full = await this.api(`/messages/${encodeURIComponent(messageId)}?format=full`);
    const normalized = normalizeGmailMessage(full, source);
    if (normalized) this.outbox.put(`gmail-message:${messageId}`, '/internal/events', normalized);
  }

  async api(pathname) {
    let token = await this.accessToken();
    let response = await this.fetch(`${API_ROOT}${pathname}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (response.status === 401) {
      this.credentials.accessToken = null;
      token = await this.accessToken();
      response = await this.fetch(`${API_ROOT}${pathname}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw statusError(response.status, payload.error?.message || `Gmail API request failed (${response.status}).`);
    return payload;
  }

  async accessToken() {
    const validUntil = new Date(this.credentials.accessTokenExpiresAt || 0).valueOf();
    if (this.credentials.accessToken && validUntil > Date.now() + 60_000) return this.credentials.accessToken;
    if (!this.credentials.refreshToken) throw statusError(401, 'Gmail is not connected.');
    const token = await this.tokenRequest({
      client_id: this.config.clientId, client_secret: this.config.clientSecret,
      refresh_token: this.credentials.refreshToken, grant_type: 'refresh_token',
    });
    this.credentials.accessToken = token.access_token;
    this.credentials.accessTokenExpiresAt = expiry(token.expires_in);
    this.secretStore.save(this.credentials);
    return this.credentials.accessToken;
  }

  async tokenRequest(parameters) {
    const response = await this.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(parameters), signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw statusError(response.status, payload.error_description || payload.error || 'Google OAuth failed.');
    return payload;
  }

  async deliver() {
    if (this.delivering || !this.config.bridgeToken) return;
    this.delivering = true;
    try {
      for (const event of this.outbox.pending()) {
        try {
          const response = await this.fetch(`${this.config.appUrl}${event.endpoint}`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': this.config.bridgeToken },
            body: JSON.stringify(event.payload), signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          this.outbox.delivered(event.id);
        } catch {
          this.outbox.failed(event.id);
          break;
        }
      }
    } finally { this.delivering = false; }
  }

  recordError(error) {
    this.lastError = error?.status === 401 ? 'authorization_expired' : 'sync_failed';
    console.error(`Gmail sync failed: ${error.message}`);
  }
}

function hash(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function expiry(seconds) { return new Date(Date.now() + Math.max(Number(seconds) || 3600, 60) * 1000).toISOString(); }
function statusError(status, message) { return Object.assign(new Error(message), { status }); }
