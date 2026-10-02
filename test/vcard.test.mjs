import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVCard } from '../app/web/vcard.js';

test('parses common vCard names and phone numbers', () => {
  const contacts = parseVCard(`BEGIN:VCARD\r
VERSION:3.0\r
N:Contact;Example;;;\r
FN:Example Contact\r
TEL;TYPE=CELL:+1 555 010 0001\r
TEL;TYPE=HOME:+1 555 010 0002\r
END:VCARD\r
BEGIN:VCARD\r
VERSION:4.0\r
FN:Sample Contact\r
TEL;VALUE=uri:tel:+15550100003\r
END:VCARD`);
  assert.deepEqual(contacts, [
    { name: 'Example Contact', phoneNumber: '15550100001' },
    { name: 'Example Contact', phoneNumber: '15550100002' },
    { name: 'Sample Contact', phoneNumber: '15550100003' },
  ]);
});

test('unfolds and decodes quoted-printable vCard names', () => {
  const contacts = parseVCard(`BEGIN:VCARD\nVERSION:2.1\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Ex=C3=A9mple=\n Contact\nTEL;CELL:+15550100006\nEND:VCARD`);
  assert.deepEqual(contacts, [{ name: 'Exémple Contact', phoneNumber: '15550100006' }]);
});
