import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installPairingRefresh, requestConfirmedPairingCode } from '../bridge/pairing.mjs';

const phone = '15550100001';
function fixture(query) {
  const ev = new EventEmitter();
  const ws = new EventEmitter(); ws.isOpen = true;
  const creds = { registered: false, advSecretKey: 'synthetic-secret',
    pairingEphemeralKeyPair: { public: Buffer.alloc(32, 1) }, noiseKey: { public: Buffer.alloc(32, 2) } };
  return { ev, ws, authState: { creds }, query };
}
test('phone codes wait for positive server confirmation and serialize requests', async () => {
  let accept;
  const socket = fixture(async (node, timeout) => {
    assert.equal(node.content[0].attrs.stage, 'companion_hello');
    assert.equal(node.content[0].attrs.jid, `${phone}@s.whatsapp.net`);
    assert.equal(timeout, 3500);
    return new Promise((resolve) => { accept = resolve; });
  });
  let finished = false;
  const request = requestConfirmedPairingCode(socket, phone).then((code) => { finished = true; return code; });
  await assert.rejects(requestConfirmedPairingCode(socket, phone), /pairing_not_ready/u);
  while (!accept) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(finished, false);
  accept({ tag: 'iq', attrs: { type: 'result' } });
  assert.match(await request, /^[A-Z0-9]{8}$/u);
});
test('rejected, missing, and error responses never expose an unconfirmed code or poison the next login', async () => {
  for (const query of [async () => { throw Object.assign(new Error('rejected'), { data: 400 }); },
    async () => undefined, async () => ({ tag: 'iq', attrs: { type: 'error' } })]) {
    const socket = fixture(query);
    await assert.rejects(requestConfirmedPairingCode(socket, phone));
    assert.equal(socket.authState.creds.me, undefined);
    assert.equal(socket.authState.creds.pairingCode, undefined);
  }
  const socket = fixture(async () => assert.fail('closed sockets must not send'));
  socket.ws.isOpen = false;
  await assert.rejects(requestConfirmedPairingCode(socket, phone), /pairing_not_ready/u);
});
test('refresh notifications rotate the unpaired secret and preserve QR references across later timer updates', () => {
  const socket = fixture(); installPairingRefresh(socket);
  const qrs = []; socket.ev.on('connection.update', (u) => { if (u.qr) qrs.push(u.qr); });
  const first = 'https://wa.me/settings/linked_devices#ref-1,noise,identity,old-secret,1';
  socket.ev.emit('connection.update', { qr: first });
  const notify = (tag) => socket.ws.emit('CB:notification,type:companion_reg_refresh', { content: [{ tag }] });
  notify('unrelated'); assert.equal(qrs.length, 1);
  for (const tag of ['companion_reg_refresh', 'pair-device-rotate-qr']) {
    const before = socket.authState.creds.advSecretKey;
    notify(tag);
    assert.notEqual(socket.authState.creds.advSecretKey, before);
    assert.equal(qrs.at(-1).split(',')[0], first.split(',')[0]);
    assert.equal(qrs.at(-1).split(',')[3], socket.authState.creds.advSecretKey);
  }
  socket.ev.emit('connection.update', { qr: first.replace('ref-1', 'ref-2') });
  assert.equal(qrs.at(-1).split(',')[3], socket.authState.creds.advSecretKey);
  socket.authState.creds.me = { id: `${phone}@s.whatsapp.net` };
  const before = socket.authState.creds.advSecretKey;
  notify('companion_reg_refresh');
  assert.equal(socket.authState.creds.advSecretKey, before, 'pending phone-code and paired identities keep their secret');
});
