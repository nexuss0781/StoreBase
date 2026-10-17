'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGatewayServer } = require('../../gateway/server');
const {
  connectTelegramFromGateway,
  connectTelegramReaderFromGateway,
  fetchCatalogSettings,
  fetchPublisherSettings,
} = require('../lib/gateway-client');

const TOKEN = 'test-publisher-token_0123456789-ABCDEFG';
const SETTINGS = {
  schemaVersion: 1,
  settingsVersion: 1,
  telegram: {
    apiId: 123456,
    apiHash: 'test-api-hash',
    botSession: 'test-bot-session',
    readSession: 'test-read-session',
    channel: '@storebase_test',
  },
};
const READ_SETTINGS = {
  schemaVersion: 1,
  settingsVersion: 1,
  telegram: {
    apiId: 123456,
    apiHash: 'test-api-hash',
    readSession: 'test-read-session',
    channel: '@storebase_test',
  },
};

async function withServer(t, options = {}) {
  const server = createGatewayServer({
    publisherToken: TOKEN,
    publisherSettingsLoader: () => SETTINGS,
    ...options,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('read-only catalog commands fetch only the encrypted reader settings without a publisher token', async (t) => {
  const gatewayUrl = await withServer(t, { settingsLoader: () => READ_SETTINGS });
  const settings = await fetchCatalogSettings({ STOREBASE_GATEWAY_URL: gatewayUrl });
  assert.deepEqual(settings, READ_SETTINGS);
  assert.equal(Object.hasOwn(settings.telegram, 'botSession'), false);
});

test('read-only gateway connector blanks its temporary configuration after login', async () => {
  let seen;
  let retainedEnv;
  const connection = await connectTelegramReaderFromGateway({}, {
    fetchSettings: async () => structuredClone(READ_SETTINGS),
    connectTelegramReader: async (env) => {
      retainedEnv = env;
      seen = { ...env };
      return { client: {}, channelEntity: {} };
    },
  });
  assert.equal(seen.STOREBASE_TELEGRAM_READ_SESSION, 'test-read-session');
  assert.equal(seen.STOREBASE_TELEGRAM_CHANNEL, '@storebase_test');
  assert.equal(retainedEnv.STOREBASE_TELEGRAM_API_HASH, '');
  assert.equal(retainedEnv.STOREBASE_TELEGRAM_READ_SESSION, '');
  assert.equal(Object.hasOwn(connection, 'readSession'), false);
});

test('npm gateway client decrypts publisher settings from the signed gateway route', async (t) => {
  const gatewayUrl = await withServer(t);
  const settings = await fetchPublisherSettings({
    STOREBASE_GATEWAY_URL: gatewayUrl,
    STOREBASE_GATEWAY_PUBLISH_TOKEN: TOKEN,
  });
  assert.deepEqual(settings, SETTINGS);
});

test('publisher token is not returned by the encrypted settings endpoint', async (t) => {
  const gatewayUrl = await withServer(t);
  const settings = await fetchPublisherSettings({
    STOREBASE_GATEWAY_URL: gatewayUrl,
    STOREBASE_GATEWAY_PUBLISH_TOKEN: TOKEN,
  });
  assert.equal(JSON.stringify(settings).includes(TOKEN), false);
});

test('publisher bootstrap refuses missing or invalid client tokens', async (t) => {
  const gatewayUrl = await withServer(t);
  await assert.rejects(fetchPublisherSettings({ STOREBASE_GATEWAY_URL: gatewayUrl }), /STOREBASE_GATEWAY_PUBLISH_TOKEN/);
  await assert.rejects(fetchPublisherSettings({
    STOREBASE_GATEWAY_URL: gatewayUrl,
    STOREBASE_GATEWAY_PUBLISH_TOKEN: 'too-short',
  }), /STOREBASE_GATEWAY_PUBLISH_TOKEN/);
  await assert.rejects(fetchPublisherSettings({
    STOREBASE_GATEWAY_URL: gatewayUrl,
    STOREBASE_GATEWAY_PUBLISH_TOKEN: 'another-valid-length-token-0123456789',
  }), /HTTP 401/);
});

test('gateway connector gives Telegram settings only to the connection function and scrubs its returned session fields', async () => {
  let observed;
  let retainedEnv;
  const connection = await connectTelegramFromGateway({}, {
    fetchSettings: async () => structuredClone(SETTINGS),
    connectTelegram: async (env, options) => {
      retainedEnv = env;
      observed = { env: { ...env }, options };
      return {
        client: {},
        readerClient: {},
        session: env.STOREBASE_TELEGRAM_SESSION,
        readSession: env.STOREBASE_TELEGRAM_READ_SESSION,
        hasStoredSession: true,
      };
    },
  });
  assert.equal(observed.env.STOREBASE_TELEGRAM_API_ID, '123456');
  assert.equal(observed.env.STOREBASE_TELEGRAM_API_HASH, 'test-api-hash');
  assert.equal(observed.env.STOREBASE_TELEGRAM_SESSION, 'test-bot-session');
  assert.equal(observed.env.STOREBASE_TELEGRAM_READ_SESSION, 'test-read-session');
  assert.equal(observed.options.requireReader, true);
  assert.equal(retainedEnv.STOREBASE_TELEGRAM_API_HASH, '');
  assert.equal(retainedEnv.STOREBASE_TELEGRAM_SESSION, '');
  assert.equal(retainedEnv.STOREBASE_TELEGRAM_READ_SESSION, '');
  assert.equal(Object.hasOwn(connection, 'session'), false);
  assert.equal(Object.hasOwn(connection, 'readSession'), false);
  assert.equal(Object.hasOwn(connection, 'hasStoredSession'), false);
});
