'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, sign, privateDecrypt, createDecipheriv, constants } = require('node:crypto');
const {
  APP_ID,
  PUBLISHER_BOOTSTRAP_PATH,
  TELEGRAM_BOOTSTRAP_PATH,
  canonicalRequest,
  envelopeAad,
} = require('../protocol');
const { createGatewayServer, loadPublisherSettings, loadTelegramSettings } = require('../server');

function makeClientKeyPair() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 });
}

function signedRequest(pair, overrides = {}, path = TELEGRAM_BOOTSTRAP_PATH) {
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const body = {
    appId: APP_ID,
    requestId: 'c8b2b97d-65a4-4d76-9f13-2f7e75e1ab83',
    timestamp: Date.now(),
    publicKey,
    ...overrides,
  };
  body.signature = sign('RSA-SHA256', Buffer.from(canonicalRequest({ ...body, path })), pair.privateKey).toString('base64');
  return body;
}

async function withServer(t, options) {
  const server = createGatewayServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function postBootstrap(baseUrl, body) {
  return fetch(`${baseUrl}${TELEGRAM_BOOTSTRAP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('gateway settings loader selects only read-only Telegram credentials', () => {
  const settings = loadTelegramSettings({
    STOREBASE_TELEGRAM_API_ID: '123456',
    STOREBASE_TELEGRAM_API_HASH: 'a'.repeat(32),
    STOREBASE_TELEGRAM_READ_SESSION: 'reader-session-secret',
    STOREBASE_TELEGRAM_CHANNEL: '@storebase_channel',
    STOREBASE_TELEGRAM_BOT_TOKEN: 'must-not-be-included',
    STOREBASE_TELEGRAM_SESSION: 'admin-bot-session-must-not-be-included',
  });
  assert.deepEqual(Object.keys(settings.telegram).sort(), ['apiHash', 'apiId', 'channel', 'readSession']);
  assert.equal(JSON.stringify(settings).includes('must-not-be-included'), false);
});

test('publisher settings loader returns only the minimum runtime Telegram settings', () => {
  const settings = loadPublisherSettings({
    STOREBASE_TELEGRAM_API_ID: '123456',
    STOREBASE_TELEGRAM_API_HASH: 'a'.repeat(32),
    STOREBASE_TELEGRAM_SESSION: 'stored-bot-session',
    STOREBASE_TELEGRAM_READ_SESSION: 'reader-session',
    STOREBASE_TELEGRAM_CHANNEL: '@storebase_channel',
    STOREBASE_TELEGRAM_BOT_TOKEN: 'must-not-be-forwarded',
  });
  assert.deepEqual(Object.keys(settings.telegram).sort(), ['apiHash', 'apiId', 'botSession', 'channel', 'readSession']);
  assert.equal(settings.telegram.botSession, 'stored-bot-session');
  assert.equal(JSON.stringify(settings).includes('must-not-be-forwarded'), false);
  assert.throws(() => loadPublisherSettings({
    STOREBASE_TELEGRAM_API_ID: '123456',
    STOREBASE_TELEGRAM_API_HASH: 'a'.repeat(32),
    STOREBASE_TELEGRAM_BOT_TOKEN: 'valid-but-not-returned',
    STOREBASE_TELEGRAM_READ_SESSION: 'reader-session',
    STOREBASE_TELEGRAM_CHANNEL: '@storebase_channel',
  }), /stored Telegram bot session/);
});

test('gateway serves only an authenticated encrypted one-time Telegram settings bootstrap', async (t) => {
  const pair = makeClientKeyPair();
  const settings = {
    schemaVersion: 1,
    settingsVersion: 1,
    telegram: { apiId: 123456, apiHash: 'a'.repeat(32), readSession: 'personal-reader-session-secret', channel: '@storebase_channel' },
  };
  let loadCount = 0;
  const baseUrl = await withServer(t, { settingsLoader: async () => { loadCount += 1; return settings; } });
  const body = signedRequest(pair);
  const response = await postBootstrap(baseUrl, body);
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.protocol, 'STOREBASE_GATEWAY_V1');
  assert.equal(envelope.requestId, body.requestId);
  assert.equal(JSON.stringify(envelope).includes('personal-reader-session-secret'), false);
  const contentKey = privateDecrypt({
    key: pair.privateKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, Buffer.from(envelope.encryptedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(envelopeAad(envelope)));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  assert.deepEqual(JSON.parse(plaintext.toString('utf8')), settings);
  assert.equal(loadCount, 1);

  const wrongPathSignature = signedRequest(pair, {}, '/api/v1/telegram/bootstrap');
  assert.equal((await postBootstrap(baseUrl, wrongPathSignature)).status, 401);
  const legacyBody = signedRequest(pair, { requestId: '4c2e9d8f-9d4c-4bb2-8e3d-789b54f930ce' }, '/api/v1/telegram/bootstrap');
  const legacyResponse = await fetch(`${baseUrl}/api/v1/telegram/bootstrap`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(legacyBody),
  });
  assert.equal(legacyResponse.status, 200);
  assert.equal(loadCount, 1);
});

test('gateway does not expose catalog relay or update artifacts', async (t) => {
  const baseUrl = await withServer(t, { settingsLoader: () => { throw new Error('Must not be called.'); } });
  assert.equal((await fetch(`${baseUrl}/api/v1/catalog/bootstrap`, { method: 'GET' })).status, 405);
  assert.equal((await fetch(`${baseUrl}/updates/stable.json`)).status, 404);
});

test('publisher bootstrap requires the shared token and returns only an encrypted settings envelope', async (t) => {
  const pair = makeClientKeyPair();
  const token = 'publisher-token-test_0123456789-ABCDEFG';
  const settings = {
    schemaVersion: 1,
    settingsVersion: 1,
    telegram: { apiId: 123456, apiHash: 'hash', botSession: 'bot-session-secret', readSession: 'reader-session-secret', channel: '@storebase_channel' },
  };
  let loadCount = 0;
  const baseUrl = await withServer(t, {
    publisherToken: token,
    publisherSettingsLoader: async () => { loadCount += 1; return settings; },
  });
  const authorized = signedRequest(pair, { publishToken: token }, PUBLISHER_BOOTSTRAP_PATH);
  const response = await fetch(`${baseUrl}${PUBLISHER_BOOTSTRAP_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(authorized),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(JSON.stringify(envelope).includes('bot-session-secret'), false);
  assert.equal(JSON.stringify(envelope).includes('reader-session-secret'), false);
  const contentKey = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.encryptedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(envelopeAad(envelope)));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  assert.deepEqual(JSON.parse(plaintext.toString('utf8')), settings);
  const denied = signedRequest(pair, { publishToken: 'wrong-publisher-token_0123456789-ABCDEFG' }, PUBLISHER_BOOTSTRAP_PATH);
  const deniedResponse = await fetch(`${baseUrl}${PUBLISHER_BOOTSTRAP_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(denied),
  });
  assert.equal(deniedResponse.status, 401);
  assert.equal(loadCount, 1);
});

test('publisher bootstrap stays closed until a high-entropy token is configured', async (t) => {
  const pair = makeClientKeyPair();
  const body = signedRequest(pair, { publishToken: 'publisher-token-test_0123456789-ABCDEFG' }, PUBLISHER_BOOTSTRAP_PATH);
  const baseUrl = await withServer(t, { publisherToken: '' });
  const response = await fetch(`${baseUrl}${PUBLISHER_BOOTSTRAP_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 503);
});

test('gateway rejects invalid signatures and expired requests, and prevents bootstrap replay', async (t) => {
  const pair = makeClientKeyPair();
  let loadCount = 0;
  const baseUrl = await withServer(t, {
    settingsLoader: async () => {
      loadCount += 1;
      return { schemaVersion: 1, settingsVersion: 1, telegram: { apiId: 123456, apiHash: 'a'.repeat(32), readSession: 'reader-session', channel: '@storebase_channel' } };
    },
  });
  const invalid = signedRequest(pair);
  invalid.signature = Buffer.alloc(256, 7).toString('base64');
  assert.equal((await postBootstrap(baseUrl, invalid)).status, 401);
  const expired = signedRequest(pair, { requestId: 'c5b31f7d-65a4-4d76-9f13-2f7e75e1ab83', timestamp: Date.now() - 10 * 60 * 1000 });
  assert.equal((await postBootstrap(baseUrl, expired)).status, 401);
  assert.equal(loadCount, 0);

  const valid = signedRequest(pair);
  assert.equal((await postBootstrap(baseUrl, valid)).status, 200);
  assert.equal((await postBootstrap(baseUrl, valid)).status, 409);
  assert.equal(loadCount, 1);
});
