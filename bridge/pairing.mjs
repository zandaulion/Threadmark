import { randomBytes } from 'node:crypto';
import { aesEncryptCTR, bytesToCrockford, derivePairingCodeKey, getCompanionPlatformId, jidEncode, S_WHATSAPP_NET } from '@whiskeysockets/baileys';

const pending = new WeakSet();

// Baileys rc14 returns a code after sendNode, before the server accepts it.
// Use its query path so an IQ rejection or timeout cannot yield a fake success.
export async function requestConfirmedPairingCode(socket, phoneNumber, { timeout = 3500 } = {}) {
  if (!socket?.ws.isOpen || socket.authState.creds.registered || socket.authState.creds.account || pending.has(socket)) {
    throw new Error('pairing_not_ready');
  }
  pending.add(socket);
  const creds = socket.authState.creds;
  const code = bytesToCrockford(randomBytes(5));
  try {
    const salt = randomBytes(32);
    const iv = randomBytes(16);
    const key = await derivePairingCodeKey(code, salt);
    const wrapped = Buffer.concat([salt, iv, aesEncryptCTR(creds.pairingEphemeralKeyPair.public, key, iv)]);
    // These must be available when the phone sends companion_finish.
    creds.pairingCode = code;
    creds.me = { id: jidEncode(phoneNumber, 's.whatsapp.net'), name: '~' };
    socket.ev.emit('creds.update', creds);
    const response = await socket.query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'md' }, content: [{
      tag: 'link_code_companion_reg', attrs: { jid: creds.me.id, stage: 'companion_hello', should_show_push_notification: 'true' },
      content: [
        { tag: 'link_code_pairing_wrapped_companion_ephemeral_pub', attrs: {}, content: wrapped },
        { tag: 'companion_server_auth_key_pub', attrs: {}, content: creds.noiseKey.public },
        { tag: 'companion_platform_id', attrs: {}, content: getCompanionPlatformId(['Threadmark', 'Chrome', '1.0.0']) },
        { tag: 'companion_platform_display', attrs: {}, content: 'Chrome (Threadmark)' },
        { tag: 'link_code_pairing_nonce', attrs: {}, content: '0' },
      ],
    }] }, timeout);
    if (response?.tag !== 'iq' || response.attrs?.type !== 'result') throw new Error('pairing_not_confirmed');
    return code;
  } catch (error) {
    if (creds.pairingCode === code && !creds.registered && !creds.account) {
      delete creds.pairingCode;
      delete creds.me;
      socket.ev.emit('creds.update', { pairingCode: undefined, me: undefined });
    }
    throw error;
  } finally { pending.delete(socket); }
}

// Compatibility with the refresh route in upstream PR #2765. Generic Baileys
// notification handling still sends the ACK. No stanza/key/QR data is logged.
export function installPairingRefresh(socket) {
  let latestQr;
  const creds = socket.authState.creds;
  const currentSecret = (qr) => {
    const fields = qr.split(',');
    if (fields.length !== 5) return qr;
    fields[3] = creds.advSecretKey;
    return fields.join(',');
  };
  socket.ev.on('connection.update', (update) => {
    if (update.qr) latestQr = update.qr = currentSecret(update.qr);
    if (update.connection === 'open' || update.connection === 'close') latestQr = null;
  });
  socket.ws.on('CB:notification,type:companion_reg_refresh', (node) => {
    if (creds.me || creds.registered || !Array.isArray(node.content)
      || !node.content.some((child) => ['companion_reg_refresh', 'pair-device-rotate-qr'].includes(child.tag))) return;
    creds.advSecretKey = randomBytes(32).toString('base64');
    socket.ev.emit('creds.update', { advSecretKey: creds.advSecretKey });
    if (latestQr) socket.ev.emit('connection.update', { qr: currentSecret(latestQr) });
  });
}
