'use strict';

const {
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  constants,
  sign,
  randomUUID,
} = require('node:crypto');

const PROTOCOL = 'STOREBASE_GATEWAY_V1';
const APP_ID = 'com.nexuss0781.storebase';
const CATALOG_BOOTSTRAP_PATH = '/api/v1/catalog/bootstrap';
const PUBLISHER_BOOTSTRAP_PATH = '/api/v1/publisher/bootstrap';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024 + 64 * 1024;

function fail(message) {
  throw new Error(message);
}

function base64Bytes(value, label, maxBytes) {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes * 4 / 3) + 8) {
    fail(`Gateway response has an invalid ${label}.`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.length > maxBytes || decoded.toString('base64') !== value) {
    fail(`Gateway response has an invalid ${label}.`);
  }
  return decoded;
}

function canonicalRequest({ appId, requestId, timestamp, publicKey, publishToken, path }) {
  const fields = [PROTOCOL, 'POST', path, appId, requestId, String(timestamp), publicKey];
  if (path === PUBLISHER_BOOTSTRAP_PATH) fields.push(publishToken || '');
  return fields.join('\n');
}

function canonicalPublisherRequest(request) {
  return canonicalRequest({ ...request, path: PUBLISHER_BOOTSTRAP_PATH });
}

function envelopeAad(envelope) {
  return [PROTOCOL, APP_ID, envelope.requestId, envelope.issuedAt].join('\n');
}

function validateCatalogSettings(settings) {
  const telegram = settings?.telegram;
  if (!settings || settings.schemaVersion !== 1 || settings.settingsVersion !== 1
      || !telegram || !Number.isSafeInteger(telegram.apiId) || telegram.apiId <= 0
      || typeof telegram.apiHash !== 'string' || !telegram.apiHash
      || typeof telegram.readSession !== 'string' || !telegram.readSession
      || typeof telegram.channel !== 'string' || !telegram.channel.trim()
      || Object.hasOwn(telegram, 'botSession') || Object.hasOwn(telegram, 'botToken')) {
    fail('Gateway returned invalid read-only Telegram settings.');
  }
  return settings;
}

function validatePublisherSettings(settings) {
  const telegram = settings?.telegram;
  if (!settings || settings.schemaVersion !== 1 || settings.settingsVersion !== 1
      || !telegram || !Number.isSafeInteger(telegram.apiId) || telegram.apiId <= 0
      || typeof telegram.apiHash !== 'string' || !telegram.apiHash
      || typeof telegram.botSession !== 'string' || !telegram.botSession
      || typeof telegram.readSession !== 'string' || !telegram.readSession
      || typeof telegram.channel !== 'string' || !telegram.channel.trim()
      || Object.hasOwn(telegram, 'botToken')) {
    fail('Gateway returned invalid Telegram publisher settings.');
  }
  return settings;
}

function decryptSettings(envelope, privateKey, requestId, validator = validatePublisherSettings) {
  if (!envelope || envelope.protocol !== PROTOCOL || envelope.appId !== APP_ID
      || envelope.requestId !== requestId || typeof envelope.issuedAt !== 'string'
      || envelope.keyWrap !== 'RSA-OAEP-SHA256' || envelope.contentEncryption !== 'AES-256-GCM') {
    fail('Gateway returned an invalid or mismatched encrypted settings envelope.');
  }
  const wrappedKey = base64Bytes(envelope.encryptedKey, 'wrapped key', 16 * 1024);
  const iv = base64Bytes(envelope.iv, 'initialization vector', 32);
  const ciphertext = base64Bytes(envelope.ciphertext, 'ciphertext', MAX_RESPONSE_BYTES);
  const tag = base64Bytes(envelope.tag, 'authentication tag', 32);
  if (iv.length !== 12 || tag.length !== 16) fail('Gateway returned an invalid encryption envelope.');

  let contentKey;
  let plaintext;
  try {
    contentKey = privateDecrypt({
      key: privateKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    }, wrappedKey);
    if (contentKey.length !== 32) fail('Gateway returned an invalid content key.');
    const decipher = createDecipheriv('aes-256-gcm', contentKey, iv);
    decipher.setAAD(Buffer.from(envelopeAad(envelope), 'utf8'));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return validator(JSON.parse(plaintext.toString('utf8')));
  } catch {
    fail('Could not authenticate or decrypt the gateway settings response.');
  } finally {
    contentKey?.fill(0);
    plaintext?.fill(0);
    wrappedKey.fill(0);
    iv.fill(0);
    ciphertext.fill(0);
    tag.fill(0);
  }
}

function resolveGatewayUrl(env, pathname) {
  const configured = env.STOREBASE_GATEWAY_URL || 'https://storebase.wasmer.app';
  let base;
  try {
    base = new URL(configured);
  } catch {
    fail('STOREBASE_GATEWAY_URL must be a valid HTTPS URL.');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !loopback) || base.username || base.password || base.search || base.hash) {
    fail('STOREBASE_GATEWAY_URL must use HTTPS and must not contain credentials, query parameters, or a fragment.');
  }
  return new URL(pathname, base);
}

async function fetchEncryptedSettings(env, pathname, validator, options = {}) {
  const publisher = pathname === PUBLISHER_BOOTSTRAP_PATH;
  const publishToken = publisher ? env.STOREBASE_GATEWAY_PUBLISH_TOKEN : undefined;
  if (publisher && (typeof publishToken !== 'string' || !TOKEN_PATTERN.test(publishToken))) {
    fail('Set STOREBASE_GATEWAY_PUBLISH_TOKEN to the high-entropy publisher access token.');
  }
  const endpoint = resolveGatewayUrl(env, pathname);
  const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const requestId = (options.randomUUID || randomUUID)();
  const timestamp = (options.now || Date.now)();
  const unsigned = {
    appId: APP_ID,
    requestId,
    timestamp,
    publicKey,
    ...(publisher ? { publishToken } : {}),
  };
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(canonicalRequest({ ...unsigned, path: pathname }), 'utf8'),
    keyPair.privateKey,
  ).toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
  timeout.unref?.();

  try {
    const response = await (options.fetch || globalThis.fetch)(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...unsigned, signature }),
    });
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) fail('Gateway response exceeded the allowed size.');
    if (!response.ok) fail(`Gateway bootstrap failed with HTTP ${response.status}.`);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) fail('Gateway response exceeded the allowed size.');
    let envelope;
    try { envelope = JSON.parse(text); } catch { fail('Gateway returned an invalid response.'); }
    return decryptSettings(envelope, keyPair.privateKey, requestId, validator);
  } catch (error) {
    if (/^Gateway |^Set STOREBASE_|^Could not authenticate|^Gateway response/.test(error.message || '')) throw error;
    if (error?.name === 'AbortError') fail('Gateway bootstrap timed out.');
    fail('Could not connect to the StoreBase gateway bootstrap.');
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPublisherSettings(env = process.env, options = {}) {
  return fetchEncryptedSettings(env, PUBLISHER_BOOTSTRAP_PATH, validatePublisherSettings, options);
}

async function fetchCatalogSettings(env = process.env, options = {}) {
  return fetchEncryptedSettings(env, CATALOG_BOOTSTRAP_PATH, validateCatalogSettings, options);
}

function scrubConnectionError(error, runtimeEnv) {
  let message = String(error?.message || 'Telegram connection failed.');
  for (const secret of Object.values(runtimeEnv)) {
    if (secret && secret.length > 8) message = message.split(secret).join('[redacted]');
  }
  return new Error(message);
}

async function connectTelegramFromGateway(env = process.env, options = {}) {
  const settings = await (options.fetchSettings || fetchPublisherSettings)(env, options);
  const telegram = settings.telegram;
  const runtimeEnv = {
    STOREBASE_TELEGRAM_API_ID: String(telegram.apiId),
    STOREBASE_TELEGRAM_API_HASH: telegram.apiHash,
    STOREBASE_TELEGRAM_SESSION: telegram.botSession,
    STOREBASE_TELEGRAM_READ_SESSION: telegram.readSession,
    STOREBASE_TELEGRAM_CHANNEL: telegram.channel,
  };
  try {
    const connector = options.connectTelegram || require('./telegram-client').connectTelegram;
    const connection = await connector(runtimeEnv, { requireReader: true });
    delete connection.session;
    delete connection.readSession;
    delete connection.hasStoredSession;
    return connection;
  } catch (error) {
    throw scrubConnectionError(error, runtimeEnv);
  } finally {
    for (const key of Object.keys(runtimeEnv)) runtimeEnv[key] = '';
    telegram.apiHash = '';
    telegram.botSession = '';
    telegram.readSession = '';
    telegram.channel = '';
  }
}

async function connectTelegramReaderFromGateway(env = process.env, options = {}) {
  const settings = await (options.fetchSettings || fetchCatalogSettings)(env, options);
  const telegram = settings.telegram;
  const runtimeEnv = {
    STOREBASE_TELEGRAM_API_ID: String(telegram.apiId),
    STOREBASE_TELEGRAM_API_HASH: telegram.apiHash,
    STOREBASE_TELEGRAM_READ_SESSION: telegram.readSession,
    STOREBASE_TELEGRAM_CHANNEL: telegram.channel,
  };
  try {
    const connector = options.connectTelegramReader || require('./telegram-client').connectTelegramReader;
    return await connector(runtimeEnv);
  } catch (error) {
    throw scrubConnectionError(error, runtimeEnv);
  } finally {
    for (const key of Object.keys(runtimeEnv)) runtimeEnv[key] = '';
    telegram.apiHash = '';
    telegram.readSession = '';
    telegram.channel = '';
  }
}

module.exports = {
  APP_ID,
  CATALOG_BOOTSTRAP_PATH,
  PUBLISHER_BOOTSTRAP_PATH,
  canonicalPublisherRequest,
  canonicalRequest,
  connectTelegramFromGateway,
  connectTelegramReaderFromGateway,
  decryptSettings,
  fetchCatalogSettings,
  fetchPublisherSettings,
  validateCatalogSettings,
  validatePublisherSettings,
};
