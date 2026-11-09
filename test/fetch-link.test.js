/**
 * test/fetch-link.test.js — the strict link reader (MCP-Fetch-1)
 * node:test only.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readLink, transferKeys, MAX_LINK_BYTES } from '../src/fetch/link.js';
import { FetchStop } from '../src/fetch/stop.js';
import { derivePartKey, encryptPart, decryptPart } from '../src/crypto.js';

const hosts = ['share.refueler.io'];
const UUID = '3a4d8828-6812-4eb9-9b5d-e31b60c72fac';
const K = Buffer.alloc(32, 7).toString('base64url');
const blobOf = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const good = { v: 2, k: K, n: 'a.bin', z: 10 };
const linkOf = (obj, uuid = UUID) => `https://share.refueler.io/?uuid=${uuid}#${blobOf(obj)}`;

function codeOf(text, opts = { hosts }) {
  try {
    readLink(text, opts);
  } catch (e) {
    assert.ok(e instanceof FetchStop, 'only a FetchStop may leave the reader');
    return e.code;
  }
  return 'ok';
}

describe('readLink — accepts', () => {
  test('a v2 link, returning only what a fetch needs', () => {
    const r = readLink(linkOf(good), { hosts });
    assert.equal(r.v, 2);
    assert.equal(r.uuid, UUID);
    assert.equal(r.name, 'a.bin');
    assert.equal(r.sizeBytes, 10);
    assert.deepEqual([...r.keyBytes], Array(32).fill(7));
  });

  test('a trailing newline, as a saved file has', () => {
    assert.equal(codeOf(`${linkOf(good)}\n`), 'ok');
  });

  test('a permanent-record link, whose seal field is checked then dropped', () => {
    const r = readLink(linkOf({ ...good, s: Buffer.alloc(12, 1).toString('base64url') }), { hosts });
    assert.equal(r.s, undefined);
    assert.equal(r.sealNonce, undefined);
  });

  test('a configured sandbox host', () => {
    const link = linkOf(good).replace('share.refueler.io', 'share.test');
    assert.equal(codeOf(link, { hosts: [...hosts, 'share.test'] }), 'ok');
  });
});

describe('readLink — version switch', () => {
  test('3 is refused until MCP-Fetch-2', () => {
    assert.equal(codeOf(`https://share.refueler.io/?v=3#${blobOf({ v: 3, u: UUID, k: K, n: 'a', z: 1 })}`), 'link_v3_not_yet');
  });

  for (const v of [1, 0, 4, '2', null, undefined, 2.5]) {
    test(`v = ${JSON.stringify(v)} goes to a browser`, () => {
      assert.equal(codeOf(linkOf({ ...good, v })), 'open_in_browser');
    });
  }

  test('a v0 #uuid=&key= link goes to a browser', () => {
    assert.equal(codeOf(`https://share.refueler.io/#uuid=${UUID}&key=abc`), 'open_in_browser');
  });

  test('a blob that is not a JSON object goes to a browser', () => {
    assert.equal(codeOf(`https://share.refueler.io/?uuid=${UUID}#${Buffer.from('[{"v":2}]').toString('base64url')}`), 'open_in_browser');
  });

  test('a raw legacy key goes to a browser, and is never read as a key', () => {
    const raw = Buffer.alloc(32, 9).toString('base64url');
    assert.equal(codeOf(`https://share.refueler.io/?uuid=${UUID}#${raw}`), 'open_in_browser');
  });
});

describe('readLink — malformed shapes', () => {
  const blob = blobOf(good);
  const cases = {
    'empty':                 '',
    'whitespace only':       '   \n',
    'not a URL':             'hello',
    'space inside':          `https://share.refueler.io/ ?uuid=${UUID}#${blob}`,
    'tab inside':            `https://share.refueler.io/\t?uuid=${UUID}#${blob}`,
    'backslash path':        `https://share.refueler.io\\?uuid=${UUID}#${blob}`,
    'user in authority':     `https://a@share.refueler.io/?uuid=${UUID}#${blob}`,
    'port':                  `https://share.refueler.io:8443/?uuid=${UUID}#${blob}`,
    'other path':            `https://share.refueler.io/x?uuid=${UUID}#${blob}`,
    'no fragment':           `https://share.refueler.io/?uuid=${UUID}`,
    'empty fragment':        `https://share.refueler.io/?uuid=${UUID}#`,
    'no uuid':               `https://share.refueler.io/#${blob}`,
    'extra query':           `https://share.refueler.io/?uuid=${UUID}&x=1#${blob}`,
    'second uuid':           `https://share.refueler.io/?uuid=${UUID}&uuid=${UUID}#${blob}`,
    'short uuid':            `https://share.refueler.io/?uuid=3a4d8828#${blob}`,
    'uppercase uuid':        `https://share.refueler.io/?uuid=${UUID.toUpperCase()}#${blob}`,
    'padded fragment':       `https://share.refueler.io/?uuid=${UUID}#${blob}=`,
    'fragment bad alphabet': `https://share.refueler.io/?uuid=${UUID}#${blob.slice(0, 20)}+${blob.slice(21)}`,
    'fragment cut in half':  `https://share.refueler.io/?uuid=${UUID}#${blob.slice(0, Math.floor(blob.length / 2))}`,
    'fragment last char cut': `https://share.refueler.io/?uuid=${UUID}#${blob.slice(0, -1)}`,
    'missing k':             linkOf({ v: 2, n: 'a', z: 1 }),
    'k not a string':        linkOf({ ...good, k: 5 }),
    'k too short':           linkOf({ ...good, k: Buffer.alloc(31).toString('base64url') }),
    'k too long':            linkOf({ ...good, k: Buffer.alloc(33).toString('base64url') }),
    'k bad alphabet':        linkOf({ ...good, k: `${K.slice(0, 42)}!` }),
    'k non-canonical':       linkOf({ ...good, k: `${K.slice(0, 42)}Z` }),
    'k padded':              linkOf({ ...good, k: `${K}=` }),
    'missing n':             linkOf({ v: 2, k: K, z: 1 }),
    'empty n':               linkOf({ ...good, n: '' }),
    'n not a string':        linkOf({ ...good, n: 1 }),
    'missing z':             linkOf({ v: 2, k: K, n: 'a' }),
    'z zero':                linkOf({ ...good, z: 0 }),
    'z negative':            linkOf({ ...good, z: -1 }),
    'z a float':             linkOf({ ...good, z: 1.5 }),
    'z a string':            linkOf({ ...good, z: '10' }),
    'z unsafe':              linkOf({ ...good, z: 2 ** 53 }),
    'bad s':                 linkOf({ ...good, s: '!!' }),
    'empty s':               linkOf({ ...good, s: '' }),
    'unknown field':         linkOf({ ...good, i: 'abc' }),
  };

  for (const [name, text] of Object.entries(cases)) {
    test(`${name} → link_damaged`, () => assert.equal(codeOf(text), 'link_damaged'));
  }

  test('longer than 16 KiB → link_damaged', () => {
    assert.equal(codeOf(linkOf({ ...good, n: 'x'.repeat(MAX_LINK_BYTES) })), 'link_damaged');
  });

  test('not a string → link_damaged', () => assert.equal(codeOf(null), 'link_damaged'));
});

describe('readLink — host pinning', () => {
  const blob = blobOf(good);
  for (const host of ['evil.test', 'share.refueler.io.evil.test', 'refueler.io', 'api.share.refueler.io', 'xshare.refueler.io']) {
    test(`${host} is refused`, () => {
      assert.equal(codeOf(`https://${host}/?uuid=${UUID}#${blob}`), 'link_wrong_host');
    });
  }

  test('http is refused', () => {
    assert.equal(codeOf(`http://share.refueler.io/?uuid=${UUID}#${blob}`), 'link_wrong_host');
  });

  test('a sandbox host is refused unless configured', () => {
    assert.equal(codeOf(`https://share.test/?uuid=${UUID}#${blob}`), 'link_wrong_host');
  });
});

describe('readLink — says nothing about the link', () => {
  test('no error carries any of the link', () => {
    const secret = linkOf(good);
    for (const text of [secret.slice(0, -3), `${secret}x`, secret.replace('v', ' ')]) {
      try {
        readLink(text, { hosts });
      } catch (e) {
        assert.ok(!e.detail.includes(K));
        assert.ok(!e.message.includes(K));
      }
    }
  });
});

describe('transferKeys', () => {
  test('v2 gives a part key that decrypts what a sender made', async () => {
    const K32 = new Uint8Array(32).fill(3);
    const senderKey = await derivePartKey(K32, ['encrypt']);
    const part = await encryptPart(senderKey, new Uint8Array([1, 2, 3]), 0, 1);
    const key = await transferKeys({ v: 2, keyBytes: K32 });
    assert.deepEqual([...await decryptPart(key, part, 0, 1)], [1, 2, 3]);
    assert.equal(key.extractable, false);
  });

  test('anything but an explicit case stops', async () => {
    await assert.rejects(() => transferKeys({ v: 3, keyBytes: new Uint8Array(32) }), { code: 'open_in_browser' });
    await assert.rejects(() => transferKeys({ v: 1, keyBytes: new Uint8Array(32) }), { code: 'open_in_browser' });
  });
});
