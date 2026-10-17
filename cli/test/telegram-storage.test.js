'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gzipSync } = require('node:zlib');
const { validateInput } = require('../lib/publisher');
const { readTelegramConfig, readTelegramReaderConfig } = require('../lib/telegram-client');
const {
  MANIFEST_FORMAT,
  MANIFEST_MARKER,
  createTelegramStorage,
  parseManifestMessage,
} = require('../lib/telegram-storage');

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const APK = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const CERT = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF';

class FakeTelegramClient {
  constructor() {
    this.messages = [];
    this.nextId = 100;
  }

  async sendFile(_channel, params) {
    const message = {
      id: this.nextId++,
      message: params.caption,
      fileContent: await fs.readFile(params.file),
    };
    this.messages.push(message);
    return message;
  }

  async sendMessage(_channel, params) {
    const message = { id: this.nextId++, message: params.message };
    this.messages.push(message);
    return message;
  }

  async *iterMessages(_channel, params) {
    for (const message of [...this.messages].reverse()) {
      if (message.message?.includes(params.search)) yield message;
    }
  }

  async getMessages(_channel, params) {
    return params.ids.map((id) => this.messages.find((message) => message.id === id));
  }

  async downloadMedia(message, params) {
    await fs.writeFile(params.outputFile, message.fileContent);
  }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storebase-telegram-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const avatar = path.join(root, 'icon.png');
  const apk = path.join(root, 'release.apk');
  const keystore = path.join(root, 'release.jks');
  await fs.writeFile(avatar, PNG);
  await fs.writeFile(apk, APK);
  await fs.writeFile(keystore, 'keystore placeholder');
  const input = await validateInput({
    name: 'Example App', avatar, version: '1.0.0', apk,
    category: 'Games', description: 'A small test app.', keystore,
  });
  const client = new FakeTelegramClient();
  const readerClient = new FakeTelegramClient();
  readerClient.messages = client.messages;
  const storage = createTelegramStorage(client, '@StoreBaseTest', {
    readerClient,
    readerChannel: '@StoreBaseTest',
    writerChannel: '@StoreBaseTest',
  });
  return { root, avatar, apk, input, client, readerClient, storage };
}

test('reads Telegram settings without exposing secrets and accepts a saved bot session', () => {
  const config = readTelegramConfig({
    STOREBASE_TELEGRAM_API_ID: '12345',
    STOREBASE_TELEGRAM_API_HASH: 'secret-hash',
    STOREBASE_TELEGRAM_SESSION: 'secret-session',
    STOREBASE_TELEGRAM_READ_SESSION: 'secret-read-session',
    STOREBASE_TELEGRAM_CHANNEL: '@StoreBaseApps',
  });
  assert.equal(config.apiId, 12345);
  assert.equal(config.channel, '@StoreBaseApps');
  assert.equal(config.session, 'secret-session');
  assert.equal(config.readSession, 'secret-read-session');
  assert.equal(config.botToken, undefined);
  assert.throws(() => readTelegramConfig({ STOREBASE_TELEGRAM_API_ID: '0', STOREBASE_TELEGRAM_API_HASH: 'x', STOREBASE_TELEGRAM_BOT_TOKEN: 'y', STOREBASE_TELEGRAM_CHANNEL: '@x' }), /API ID/);
  assert.throws(() => readTelegramConfig({ STOREBASE_TELEGRAM_API_ID: '12345', STOREBASE_TELEGRAM_API_HASH: 'x', STOREBASE_TELEGRAM_BOT_TOKEN: 'y', STOREBASE_TELEGRAM_CHANNEL: '@x' }), /READ_SESSION/);
});

test('read-only gateway configuration needs a Telegram reader session but no bot credentials', () => {
  const config = readTelegramReaderConfig({
    STOREBASE_TELEGRAM_API_ID: '12345',
    STOREBASE_TELEGRAM_API_HASH: 'api-hash',
    STOREBASE_TELEGRAM_READ_SESSION: 'read-session',
    STOREBASE_TELEGRAM_CHANNEL: '@StoreBaseApps',
  });
  assert.equal(config.apiId, 12345);
  assert.equal(config.channel, '@StoreBaseApps');
  assert.equal(config.readSession, 'read-session');
  assert.equal(Object.hasOwn(config, 'botToken'), false);
  assert.throws(() => readTelegramReaderConfig({ STOREBASE_TELEGRAM_API_ID: '12345', STOREBASE_TELEGRAM_API_HASH: 'x', STOREBASE_TELEGRAM_CHANNEL: '@x' }), /READ_SESSION/);
});

test('publishes a structured versioned manifest, keeps releases immutable, and downloads verified artifacts', async (t) => {
  const f = await fixture(t);
  const first = await f.storage.publish(f.input, CERT, { publishedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(first.manifest.format, MANIFEST_FORMAT);
  assert.equal(first.manifest.schemaVersion, 1);
  assert.equal(first.manifest.appId, 'example-app');
  assert.equal(first.manifest.version, '1.0.0');
  assert.equal(first.manifest.artifacts.apk.sha256.length, 64);
  assert.equal(first.manifest.artifacts.avatar.messageId > 0, true);
  assert.equal(f.client.messages.at(-1).message.startsWith(`${MANIFEST_MARKER}\n`), true);
  assert.equal(parseManifestMessage(f.client.messages.at(-1)).manifest.version, '1.0.0');

  const same = await f.storage.publish(f.input, CERT);
  assert.equal(same.idempotent, true);
  assert.equal(f.client.messages.length, 3);

  await assert.rejects(
    f.storage.publish({ ...f.input, description: 'Changed without a version bump.' }, CERT),
    /already exists.*immutable/,
  );

  const nextApk = path.join(f.root, 'release-1.1.apk');
  await fs.writeFile(nextApk, Buffer.concat([APK, Buffer.from('v1.1')]));
  const next = await f.storage.publish({ ...f.input, version: '1.1.0', apkPath: nextApk }, CERT, { publishedAt: '2026-02-01T00:00:00.000Z' });
  assert.equal(next.manifest.version, '1.1.0');
  const releases = await f.storage.listReleases();
  assert.deepEqual(releases.map((release) => release.manifest.version), ['1.1.0', '1.0.0']);

  const metadata = await f.storage.getMetadata('example-app', '1.0.0');
  assert.equal(metadata.manifest.app.description, 'A small test app.');
  const downloaded = await f.storage.download('example-app', '1.0.0', 'all', path.join(f.root, 'downloads'));
  assert.equal(downloaded.downloaded.length, 2);
  assert.equal((await fs.readFile(downloaded.downloaded.find((item) => item.kind === 'apk').path)).equals(APK), true);
  assert.equal((await fs.readFile(downloaded.downloaded.find((item) => item.kind === 'avatar').path)).equals(PNG), true);
});

test('rejects unsupported or corrupt manifest versions', () => {
  assert.equal(parseManifestMessage({ id: 1, message: 'ordinary channel post' }), null);
  assert.throws(() => parseManifestMessage({ id: 42, message: `${MANIFEST_MARKER}\n{not-json` }), /invalid JSON/);
  assert.throws(() => parseManifestMessage({ id: 43, message: `${MANIFEST_MARKER}\n{\"schemaVersion\":2}` }), /Unsupported StoreBase manifest/);
});

test('rejects manifest identifiers that could escape the download directory', () => {
  const manifest = {
    format: MANIFEST_FORMAT,
    schemaVersion: 1,
    appId: '../outside',
    app: { name: 'Example App' },
    version: '1.0.0',
    publishedAt: '2026-01-01T00:00:00.000Z',
    artifacts: {
      apk: { messageId: 1, sha256: 'a'.repeat(64), size: 1 },
      avatar: { messageId: 2, sha256: 'b'.repeat(64), size: 1 },
    },
  };
  assert.throws(() => parseManifestMessage({ id: 44, message: `${MANIFEST_MARKER}\n${JSON.stringify(manifest)}` }), /unsafe app ID or version/);
});

test('publishes and downloads an Android delta directly as a Telegram versioned artifact', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'storebase-delta-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const avatar = path.join(root, 'icon.png');
  const apk = path.join(root, 'storebase.apk');
  const delta = path.join(root, 'v1-to-v2.sbd');
  const keystore = path.join(root, 'release.jks');
  const patchBytes = gzipSync(Buffer.from('SBD1 deterministic patch fixture'));
  await Promise.all([
    fs.writeFile(avatar, PNG), fs.writeFile(apk, APK), fs.writeFile(delta, patchBytes), fs.writeFile(keystore, 'keystore placeholder'),
  ]);
  const input = await validateInput({
    name: 'StoreBase', avatar, version: '1.1.0', apk, category: 'Utilities', description: 'StoreBase app.', keystore,
    androidVersionCode: '2', minimumAndroidVersionCode: '0', delta, deltaBaseVersionCode: '1',
  });
  const writer = new FakeTelegramClient();
  const reader = new FakeTelegramClient();
  reader.messages = writer.messages;
  const storage = createTelegramStorage(writer, '@StoreBaseTest', { readerClient: reader });

  const published = await storage.publish(input, CERT, { publishedAt: '2026-03-01T00:00:00.000Z' });
  assert.deepEqual(published.manifest.androidUpdate, {
    packageName: 'com.nexuss0781.storebase', versionCode: 2, minimumVersionCode: 0,
  });
  assert.equal(published.manifest.artifacts.delta.fromVersionCode, 1);
  assert.equal(published.manifest.artifacts.delta.messageId > 0, true);
  assert.equal(writer.messages.at(-1).message.startsWith(`${MANIFEST_MARKER}\n`), true);

  const downloaded = await storage.download('storebase', '1.1.0', 'delta', path.join(root, 'downloaded'));
  assert.equal(downloaded.downloaded.length, 1);
  assert.equal(downloaded.downloaded[0].kind, 'delta');
  assert.deepEqual(await fs.readFile(downloaded.downloaded[0].path), patchBytes);
  assert.equal(parseManifestMessage(writer.messages.at(-1)).manifest.androidUpdate.versionCode, 2);
});

test("requires a signed update manifest's StoreBase version code and matching delta base", async (t) => {
  const f = await fixture(t);
  await assert.rejects(validateInput({
    name: 'StoreBase', avatar: f.avatar, version: '1.1.0', apk: f.apk,
    category: 'Utilities', description: 'StoreBase app.', keystore: f.keystore,
  }), /require --android-version-code/);
  const delta = path.join(f.root, 'bad.sbd');
  await fs.writeFile(delta, gzipSync(Buffer.from('fixture')));
  await assert.rejects(validateInput({
    name: 'StoreBase', avatar: f.avatar, version: '1.1.0', apk: f.apk,
    category: 'Utilities', description: 'StoreBase app.', keystore: f.keystore,
    androidVersionCode: '2', delta, deltaBaseVersionCode: '2',
  }), /lower than --android-version-code/);
});


test('lists every Telegram version and resolves the pinned default independently of immutable manifests', async (t) => {
  const f = await fixture(t);
  await f.storage.publish(f.input, CERT, { publishedAt: '2026-01-01T00:00:00.000Z' });
  const nextApk = path.join(f.root, 'release-1.1.apk');
  await fs.writeFile(nextApk, Buffer.concat([APK, Buffer.from('v1.1')]));
  await f.storage.publish({ ...f.input, version: '1.1.0', apkPath: nextApk }, CERT, { publishedAt: '2026-02-01T00:00:00.000Z' });

  let catalog = await f.storage.getCatalog();
  assert.equal(catalog[0].defaultVersion, '1.1.0');
  assert.equal(catalog[0].defaultPinned, false);
  assert.deepEqual(catalog[0].versions.map(({ manifest }) => manifest.version), ['1.1.0', '1.0.0']);
  assert.equal((await f.storage.getMetadata('example-app')).manifest.version, '1.1.0');

  const pin = await f.storage.pinVersion('example-app', '1.0.0');
  assert.equal(pin.idempotent, false);
  assert.equal(f.client.messages.at(-1).message.startsWith('STOREBASE_DEFAULT_VERSION_V1\n'), true);
  catalog = await f.storage.getCatalog();
  assert.equal(catalog[0].defaultVersion, '1.0.0');
  assert.equal(catalog[0].defaultPinned, true);
  assert.equal(catalog[0].pinnedAt, pin.record.pinnedAt);
  assert.equal((await f.storage.getMetadata('example-app')).manifest.version, '1.0.0');

  const samePin = await f.storage.pinVersion('example-app', '1.0.0');
  assert.equal(samePin.idempotent, true);
  assert.equal(samePin.messageId, pin.messageId);
  await assert.rejects(f.storage.pinVersion('example-app', '9.9.9'), /No Telegram release found/);
});

test('parses only well-formed Telegram default-version records', () => {
  const { parseDefaultVersionMessage } = require('../lib/telegram-storage');
  assert.equal(parseDefaultVersionMessage({ id: 1, message: 'ordinary post' }), null);
  const record = {
    format: 'storebase.default-version',
    schemaVersion: 1,
    appId: 'example-app',
    version: '1.2.3',
    pinnedAt: '2026-04-01T00:00:00.000Z',
  };
  const parsed = parseDefaultVersionMessage({ id: 2, message: `STOREBASE_DEFAULT_VERSION_V1\n${JSON.stringify(record)}` });
  assert.equal(parsed.record.version, '1.2.3');
  assert.equal(parsed.messageId, 2);
  record.appId = '../bad';
  assert.throws(() => parseDefaultVersionMessage({ id: 3, message: `STOREBASE_DEFAULT_VERSION_V1\n${JSON.stringify(record)}` }), /invalid/);
});
