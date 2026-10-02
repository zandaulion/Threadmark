import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuthStore } from '../app/server/auth.mjs';
import { openDatabase } from '../app/server/store.mjs';

test('an invite registers one revocable device', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadmark-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(dir);
  t.after(() => db.close());
  const auth = new AuthStore(db, { publicBaseUrl: 'https://threadmark.example' });
  const invite = auth.createInvite('My phone');
  assert.match(invite.url, /^https:\/\/threadmark\.example\/\?invite=/u);
  const redeemed = auth.redeemInvite(invite.code, 'Pixel');
  assert.equal(redeemed.device.label, 'Pixel');
  assert.equal(auth.redeemInvite(invite.code).error, 'invalid_invite');
  assert.equal(auth.listDevices().devices.length, 1);
  assert.equal(auth.setDeviceRevoked(redeemed.device.id, true), true);
  assert.equal(auth.deviceForToken(redeemed.token), null);
});
