'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  CATEGORIES,
  normalizeFingerprint,
  parseApkSignerFingerprints,
  parseKeystoreEntries,
  releaseApp,
  validateInput,
} = require('../lib/publisher');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const APK = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const CERT = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF';

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storebase-cli-test-'));
  const avatar = path.join(root, 'icon.png');
  const apk = path.join(root, 'release.apk');
  const keystore = path.join(root, 'release.jks');
  await fs.writeFile(avatar, PNG);
  await fs.writeFile(apk, APK);
  await fs.writeFile(keystore, 'keystore-placeholder');
  return { root, avatar, apk, keystore };
}

test('exposes all 13 categories used by StoreBase Explore', () => {
  assert.equal(CATEGORIES.length, 13);
  assert.deepEqual(CATEGORIES, [
    'Education', 'Social', 'Productivity', 'Communication', 'Entertainment', 'Games',
    'Business', 'Shopping', 'Finance', 'Utilities', 'Health & Fitness',
    'Travel & Navigation', 'AI & Machine Learning',
  ]);
});

test('validates inputs and resolves a category case-insensitively', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const input = await validateInput({
    name: 'Example App', avatar: fixture.avatar, version: '1.0.0', apk: fixture.apk,
    category: 'productivity', description: 'An example.', keystore: fixture.keystore,
  });
  assert.equal(input.id, 'example-app');
  assert.equal(input.category, 'Productivity');
  assert.equal(input.avatarExtension, '.png');
});

test('rejects unknown categories and non-image avatar files', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const input = {
    name: 'Example App', avatar: fixture.avatar, version: '1.0.0', apk: fixture.apk,
    category: 'Unknown', description: 'An example.', keystore: fixture.keystore,
  };
  await assert.rejects(validateInput(input), /Category must match/);
  await fs.writeFile(fixture.avatar, 'not an image');
  input.category = 'Games';
  await assert.rejects(validateInput(input), /Avatar must be a PNG, JPEG, or WebP/);
});

test('parses keytool private-key entries and APK signer fingerprints', () => {
  const keytoolOutput = [
    'Alias name: release',
    'Entry type: PrivateKeyEntry',
    `SHA256: ${CERT.match(/.{2}/g).join(':')}`,
    'Alias name: trusted',
    'Entry type: trustedCertEntry',
    `SHA256: ${CERT.match(/.{2}/g).join(':')}`,
  ].join('\n');
  assert.deepEqual(parseKeystoreEntries(keytoolOutput), [{ alias: 'release', fingerprint: CERT }]);
  assert.deepEqual(parseApkSignerFingerprints(`Signer #1 certificate SHA-256 digest: ${CERT.match(/.{2}/g).join(':')}`), [CERT]);
  assert.equal(normalizeFingerprint('01:23:ab'), '0123AB');
});

test('writes a catalog entry and copies only app and avatar artifacts', async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const input = await validateInput({
    name: 'Example App', avatar: fixture.avatar, version: '1.0.0', apk: fixture.apk,
    category: 'Games', description: 'An example.', keystore: fixture.keystore,
  });
  const catalogPath = path.join(fixture.root, 'catalog', 'storebase-app-list.json');
  const result = await releaseApp(input, {
    catalogPath,
    signingCertificateSha256: CERT,
    publishedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(result.catalog.apps.length, 1);
  assert.equal(result.app.id, 'example-app');
  assert.equal(result.app.signingCertificateSha256, CERT);
  assert.equal(result.app.apk.startsWith('storebase-app-assets/'), true);
  assert.equal(result.app.avatar.endsWith('.png'), true);
  assert.equal((await fs.readFile(path.join(path.dirname(catalogPath), result.app.apk))).equals(APK), true);
  assert.equal((await fs.readFile(path.join(path.dirname(catalogPath), result.app.avatar))).equals(PNG), true);
  assert.equal(await fs.readFile(fixture.keystore, 'utf8'), 'keystore-placeholder');
  assert.equal(Object.hasOwn(result.app, 'keystore'), false);

  const nextInput = { ...input, version: '1.1.0', description: 'Updated.' };
  const updated = await releaseApp(nextInput, {
    catalogPath,
    signingCertificateSha256: CERT,
    publishedAt: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(updated.catalog.apps.length, 1);
  assert.equal(updated.catalog.apps[0].version, '1.1.0');
  assert.equal(updated.catalog.apps[0].description, 'Updated.');
});
