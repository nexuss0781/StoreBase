'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function directModule() {
  return import('../../src/telegram-direct.js');
}

function manifest(version, publishedAt, messageOffset = 0) {
  return {
    format: 'storebase.app-release',
    schemaVersion: 1,
    appId: 'demo-app',
    app: { name: 'Demo app', category: 'Tools', description: `Release ${version}` },
    version,
    publishedAt,
    signingCertificateSha256: 'c'.repeat(64).toUpperCase(),
    artifacts: {
      apk: {
        fileName: `demo-${version}.apk`,
        mimeType: 'application/vnd.android.package-archive',
        size: 1234 + messageOffset,
        sha256: 'a'.repeat(64),
        messageId: 100 + messageOffset,
      },
      avatar: {
        fileName: `demo-${version}.png`,
        mimeType: 'image/png',
        size: 55,
        sha256: 'b'.repeat(64),
        messageId: 200 + messageOffset,
      },
    },
  };
}

test('direct Telegram client parses a release manifest and preserves artifact message IDs', async () => {
  const { parseManifestMessage } = await directModule();
  const value = manifest('2.0.0', '2026-01-02T00:00:00.000Z');
  const parsed = parseManifestMessage({ id: 900, text: `STOREBASE_MANIFEST_V1\n${JSON.stringify(value)}` });
  assert.equal(parsed.messageId, 900);
  assert.equal(parsed.manifest.appId, 'demo-app');
  assert.equal(parsed.manifest.artifacts.apk.messageId, 100);
  assert.equal(parsed.manifest.artifacts.apk.size, 1234);
  assert.equal(parseManifestMessage({ id: 901, text: 'ordinary channel post' }), null);
});

test('mtcute converts the Telethon-compatible Teleproto version-1 session layout', async () => {
  const { convertFromTelethonSession } = await import('@mtcute/convert');
  const payload = Buffer.alloc(1 + 4 + 2 + 256);
  payload[0] = 4;
  payload.set([149, 154, 167, 51], 1);
  payload.writeUInt16BE(443, 5);
  payload.fill(0x5a, 7);
  const converted = convertFromTelethonSession(`1${payload.toString('base64')}`);
  assert.equal(converted.authKey.length, 256);
  assert.equal(converted.primaryDcs.main.id, 4);
  assert.equal(converted.primaryDcs.main.ipAddress, '149.154.167.51');
});

test('direct Telegram client rejects malformed release hashes and identifiers', async () => {
  const { parseManifestMessage } = await directModule();
  const badHash = manifest('2.0.0', '2026-01-02T00:00:00.000Z');
  badHash.artifacts.apk.sha256 = 'invalid';
  assert.throws(() => parseManifestMessage({ id: 900, text: `STOREBASE_MANIFEST_V1\n${JSON.stringify(badHash)}` }));

  const badId = manifest('2.0.0', '2026-01-02T00:00:00.000Z');
  badId.appId = '../escape';
  assert.throws(() => parseManifestMessage({ id: 900, text: `STOREBASE_MANIFEST_V1\n${JSON.stringify(badId)}` }));
});

test('direct Telegram client validates and exposes StoreBase Android delta metadata', async () => {
  const { buildCatalog, parseManifestMessage } = await directModule();
  const value = manifest('1.1.0', '2026-01-02T00:00:00.000Z');
  value.appId = 'storebase';
  value.androidUpdate = {
    packageName: 'com.nexuss0781.storebase', versionCode: 2, minimumVersionCode: 0,
  };
  value.artifacts.delta = {
    fileName: 'StoreBase-v1-to-v2.sbd', mimeType: 'application/vnd.storebase.delta',
    size: 100, sha256: 'd'.repeat(64), messageId: 300, fromVersionCode: 1,
  };
  const release = parseManifestMessage({ id: 901, text: `STOREBASE_MANIFEST_V1\n${JSON.stringify(value)}` });
  const catalog = buildCatalog([release]);
  assert.deepEqual(catalog.apps[0].androidUpdate, value.androidUpdate);
  assert.equal(catalog.apps[0].artifacts.delta.fromVersionCode, 1);
  assert.equal(catalog.apps[0].versions[0].artifacts.delta.messageId, 300);

  value.artifacts.delta.fromVersionCode = 2;
  assert.throws(() => parseManifestMessage({ id: 902, text: `STOREBASE_MANIFEST_V1\n${JSON.stringify(value)}` }));
});

test('direct Telegram catalog selects the newest release and keeps version download references', async () => {
  const { buildCatalog, parseManifestMessage } = await directModule();
  const older = parseManifestMessage({ id: 800, text: `STOREBASE_MANIFEST_V1\n${JSON.stringify(manifest('1.0.0', '2026-01-01T00:00:00.000Z'))}` });
  const newer = parseManifestMessage({ id: 900, text: `STOREBASE_MANIFEST_V1\n${JSON.stringify(manifest('2.0.0', '2026-01-02T00:00:00.000Z', 10))}` });
  const catalog = buildCatalog([older, newer]);
  assert.equal(catalog.apps.length, 1);
  assert.equal(catalog.apps[0].version, '2.0.0');
  assert.equal(catalog.apps[0].description, 'Release 2.0.0');
  assert.deepEqual(catalog.apps[0].versions.map((release) => release.version), ['2.0.0', '1.0.0']);
  assert.equal(catalog.apps[0].versions[0].artifacts.apk.messageId, 110);
  assert.equal(catalog.apps[0].artifacts.apk.sha256, 'a'.repeat(64));
});
